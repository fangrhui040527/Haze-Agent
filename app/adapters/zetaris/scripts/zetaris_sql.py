"""Shared helpers for run_sql.py and preflight.py: env loading, SQL statement
splitting, and a REST or JDBC channel to a Zetaris instance.

Standard library only, except JDBC, which needs `jaydebeapi` (see
scripts/requirements.txt) and a JDK. Secrets are read from the environment and
never printed.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = ROOT.parents[2]
PLACEHOLDER_UA = "YOUR_APP_NAME YOUR_CONTACT_EMAIL"
DEFAULT_REST_URL = "http://localhost:8888/api/v1.0"
DEFAULT_BASE_URL = "http://localhost:3000"
LOGIN_PATH = "/api/auth/login"
# Refresh slightly early so a token cannot lapse between the check and the call.
TOKEN_SKEW_SECONDS = 60
DEFAULT_JDBC_URL = "jdbc:zetaris:lightning@localhost:10000"
DRIVER_CLASS = "com.zetaris.lightning.jdbc.LightningDriver"
ALREADY_EXISTS = re.compile(r"already exists", re.I)


class ZetarisError(RuntimeError):
    pass


# --- environment -----------------------------------------------------------


def _top_level_checkout() -> Path | None:
    """The main checkout when PROJECT_ROOT is a git worktree, else None.

    A worktree's `.git` is a file reading `gitdir: <top>/.git/worktrees/<name>`.
    """
    try:
        text = (PROJECT_ROOT / ".git").read_text(encoding="utf-8")
    except OSError:
        return None  # a normal checkout has a .git directory, not a file
    match = re.match(r"gitdir:\s*(.+)", text)
    if not match:
        return None
    gitdir = Path(match.group(1).strip())
    if not gitdir.is_absolute():
        gitdir = (PROJECT_ROOT / gitdir).resolve()
    top = gitdir.parent.parent.parent  # <top>/.git/worktrees/<name> -> <top>
    return top if top.is_dir() and top != PROJECT_ROOT else None


ENV_FILE_NAME = ".env"


def env_file_candidates() -> list[Path]:
    """Root .env first, then main checkout and legacy files for missing values."""
    dirs = [PROJECT_ROOT] + ([top] if (top := _top_level_checkout()) else [])
    return (
        [d / ENV_FILE_NAME for d in dirs]
        + [d / ".env.local" for d in dirs]
        + [d / "app/adapters/zetaris/.env.local" for d in dirs]
        + [d / "app/adapters/zetaris/.env" for d in dirs]
    )


def load_env(env_file: str | None = None) -> Path | None:
    """Load root .env and fallbacks without overriding existing variables.

    Returns the first file used, or None. An explicit env_file is used alone.
    """
    paths = [Path(env_file)] if env_file else env_file_candidates()
    loaded = None
    for path in paths:
        if not path.is_file():
            continue
        if loaded is None:
            loaded = path
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)
    return loaded


def require(*names: str) -> None:
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        raise ZetarisError("Missing in the environment or root .env: " + ", ".join(missing))


# --- SQL splitting ---------------------------------------------------------


def split_statements(text: str) -> list[str]:
    """Split SQL on semicolons outside quotes, dropping comments.

    Handles '..', "..", `..` quoting (a doubled quote is an escape) and both
    `-- line` and `/* block */` comments. A CREATE TABLE that follows
    COMPILE USL ... DDL is merged back into that statement, because a
    multi-table USL must be sent whole.
    """
    statements: list[str] = []
    buf: list[str] = []
    i, n, quote = 0, len(text), None
    while i < n:
        c = text[i]
        if quote:
            buf.append(c)
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
            buf.append(c)
        elif text.startswith("--", i):
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        elif c == ";":
            _push(statements, "".join(buf))
            buf = []
        else:
            buf.append(c)
        i += 1
    _push(statements, "".join(buf))
    return statements


def _push(statements: list[str], raw: str) -> None:
    stmt = raw.strip()
    if not stmt:
        return
    if (
        stmt.upper().startswith("CREATE TABLE")
        and statements
        and statements[-1].upper().startswith("COMPILE USL")
    ):
        statements[-1] += ";\n" + stmt
    else:
        statements.append(stmt)


def apply_user_agent(statements: list[str]) -> list[str]:
    """Replace the repo's user-agent placeholder with ZETARIS_USER_AGENT.

    Refuses to send the placeholder itself, since sources such as SEC EDGAR
    block it.
    """
    if not any(PLACEHOLDER_UA in s for s in statements):
        return statements
    ua = os.environ.get("ZETARIS_USER_AGENT", "").strip()
    if not ua:
        raise ZetarisError(
            "This script contains the user-agent placeholder "
            f"'{PLACEHOLDER_UA}'. Set ZETARIS_USER_AGENT in .env to "
            "'<app name> <contact email>'."
        )
    if '"' in ua or "'" in ua:
        raise ZetarisError("ZETARIS_USER_AGENT must not contain quotes.")
    return [s.replace(PLACEHOLDER_UA, ua) for s in statements]


# --- channels --------------------------------------------------------------


class Result:
    def __init__(self, rows: list[list[Any]] | None):
        self.rows = rows or []


def _token_expired(token: str) -> bool:
    """True when a JWT access token has passed its exp.

    /api/auth/login issues a short-lived token (about an hour). A non-JWT value
    is treated as a durable key and never considered expired.
    """
    parts = token.split(".")
    if len(parts) != 3:
        return False
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        exp = json.loads(base64.urlsafe_b64decode(padded).decode()).get("exp")
    except Exception:
        return False
    if not isinstance(exp, (int, float)):
        return False
    return exp - TOKEN_SKEW_SECONDS <= time.time()


def _mint_token() -> str:
    """Exchange ZETARIS_USERNAME/ZETARIS_PASSWORD for a fresh access token.

    Without this an unattended job depends on a token a human pasted into .env,
    which lapses about an hour later and fails as a bare HTTP 400.
    """
    require("ZETARIS_USERNAME", "ZETARIS_PASSWORD")
    base = os.environ.get("ZETARIS_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    req = Request(
        base + LOGIN_PATH,
        data=json.dumps(
            {
                "username": os.environ["ZETARIS_USERNAME"],
                "password": os.environ["ZETARIS_PASSWORD"],
            }
        ).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-Request-ID": str(uuid.uuid4())},
    )
    try:
        with urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode() or "null")
    except HTTPError as e:
        # The body is deliberately not read or echoed: a rejected login can
        # quote back what was sent, which would put the password in the error.
        raise ZetarisError(f"Zetaris login failed: HTTP {e.code}") from e
    except (URLError, OSError) as e:
        raise ZetarisError(
            f"Cannot reach {base} to sign in: {getattr(e, 'reason', e)}"
        ) from e
    for field in ("idToken", "token", "accessToken"):
        value = body.get(field) if isinstance(body, dict) else None
        if isinstance(value, str) and value:
            return value
    raise ZetarisError("Zetaris login returned no access token.")


class RestChannel:
    name = "rest"

    def __init__(self) -> None:
        self.base = os.environ.get("ZETARIS_REST_URL", DEFAULT_REST_URL).rstrip("/")
        self.org = os.environ.get("ZETARIS_ORG_ID", "1")
        self._can_refresh = bool(
            os.environ.get("ZETARIS_USERNAME") and os.environ.get("ZETARIS_PASSWORD")
        )
        self._key = os.environ.get("ZETARIS_API_KEY", "").strip()
        if not self._key and not self._can_refresh:
            raise ZetarisError(
                "Missing in the environment or root .env: ZETARIS_API_KEY, or "
                "ZETARIS_USERNAME and ZETARIS_PASSWORD so a short-lived token "
                "can be minted."
            )
        # A stored token that has already lapsed is refreshed up front rather
        # than spending a request to discover it.
        if self._can_refresh and (not self._key or _token_expired(self._key)):
            self._key = _mint_token()

    def _call(self, path: str, body: dict | None = None, _retried: bool = False) -> Any:
        req = Request(
            self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            method="POST" if body is not None else "GET",
            headers={
                "Authorization": f"Bearer {self._key}",
                "X-Org-ID": self.org,
                "X-Request-ID": str(uuid.uuid4()),
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(req, timeout=600) as resp:
                return json.loads(resp.read().decode() or "null")
        except HTTPError as e:
            detail = _short(e.read().decode(errors="replace"))
            # An expired token surfaces as a bare 400 Bad Request, so decide by
            # decoding the token rather than by trusting the status code. A 400
            # from bad SQL with a still-valid token must not spend a login.
            stale = e.code in (401, 403) or _token_expired(self._key)
            if stale and self._can_refresh and not _retried:
                self._key = _mint_token()
                return self._call(path, body, _retried=True)
            if stale:
                raise ZetarisError(
                    f"HTTP {e.code}: {detail} -- the access token may have expired; "
                    "set ZETARIS_USERNAME and ZETARIS_PASSWORD so it is refreshed "
                    "automatically."
                ) from e
            raise ZetarisError(f"HTTP {e.code}: {detail}") from e
        except (URLError, OSError) as e:
            raise ZetarisError(f"Cannot reach {self.base}: {getattr(e, 'reason', e)}") from e

    def datasources(self) -> Any:
        return self._call("/datasource/datasources")

    def run(self, sql: str, limit: int = 100) -> Result:
        out = self._call(
            "/sql-editor/sqls/run",
            {"queryId": str(uuid.uuid4()), "sql": sql, "source": "SqlEditor", "limit": limit},
        )
        return Result(out.get("data") if isinstance(out, dict) else None)

    def close(self) -> None:
        pass


def find_java_home() -> str | None:
    """A usable JDK home. On macOS `java` on PATH can be a stub that reports
    'Unable to locate a Java Runtime' even when a Homebrew JDK is installed."""
    candidates = [os.environ.get("JAVA_HOME")]
    try:
        out = subprocess.run(["/usr/libexec/java_home"], capture_output=True, text=True)
        if out.returncode == 0:
            candidates.append(out.stdout.strip())
    except OSError:
        pass
    for formula in ("openjdk@17", "openjdk@21", "openjdk@11", "openjdk"):
        for prefix in ("/opt/homebrew", "/usr/local"):
            candidates.append(f"{prefix}/opt/{formula}/libexec/openjdk.jdk/Contents/Home")
    for home in candidates:
        if home and (Path(home) / "bin" / "java").is_file():
            return home
    return None


def venv_python() -> Path | None:
    py = ROOT / ".venv" / "bin" / "python"
    return py if py.is_file() else None


class JdbcChannel:
    name = "jdbc"

    def __init__(self, jar: str | None = None) -> None:
        require("ZETARIS_USERNAME", "ZETARIS_PASSWORD")
        self.jar = jar or os.environ.get("ZETARIS_JDBC_JAR")
        if not self.jar:
            raise ZetarisError(
                "Driver JAR path not set. Pass --jar or set ZETARIS_JDBC_JAR to the "
                "full path of the Zetaris JDBC driver JAR (ask the user; do not guess)."
            )
        if not Path(self.jar).is_file():
            raise ZetarisError(f"Driver JAR not found: {self.jar}")
        home = find_java_home()
        if not home:
            raise ZetarisError(
                "No JDK found. Install one (for example `brew install openjdk@17`) and set JAVA_HOME."
            )
        os.environ["JAVA_HOME"] = home
        try:
            import jaydebeapi
        except ImportError as e:
            raise ZetarisError(
                "jaydebeapi is not installed in this Python. Create a venv and run "
                "`.venv/bin/pip install -r scripts/requirements.txt`."
            ) from e
        self._conn = jaydebeapi.connect(
            DRIVER_CLASS,
            os.environ.get("ZETARIS_JDBC_URL", DEFAULT_JDBC_URL),
            [os.environ["ZETARIS_USERNAME"], os.environ["ZETARIS_PASSWORD"]],
            self.jar,
        )
        self._cur = self._conn.cursor()

    def run(self, sql: str, limit: int = 100) -> Result:
        try:
            self._cur.execute(sql)
        except Exception as e:  # jaydebeapi raises java exceptions
            raise ZetarisError(_short(str(e))) from e
        try:
            rows = self._cur.fetchall()
        except Exception:
            return Result(None)
        return Result([list(r) for r in rows[:limit]])

    def close(self) -> None:
        self._conn.close()


def open_channel(name: str, jar: str | None = None):
    if name == "rest":
        return RestChannel()
    if name == "jdbc":
        return JdbcChannel(jar)
    raise ZetarisError(f"Unknown channel: {name}")


def reexec_in_venv_if_needed(channel: str) -> None:
    """For JDBC, hop into .venv when this interpreter lacks jaydebeapi."""
    if channel != "jdbc":
        return
    try:
        import jaydebeapi  # noqa: F401
    except ImportError:
        py = venv_python()
        if py and Path(sys.prefix).resolve() != (ROOT / ".venv").resolve() and not os.environ.get("_ZETARIS_REEXEC"):
            os.environ["_ZETARIS_REEXEC"] = "1"
            os.execv(str(py), [str(py), *sys.argv])


def _short(text: str, n: int = 400) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[:n] + "..."
