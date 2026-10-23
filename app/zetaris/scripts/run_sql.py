#!/usr/bin/env python3
"""Run a Zetaris SQL script one statement at a time.

    python3 scripts/run_sql.py open_data/rest_apis/sql/rate_limited/12_company_dns_create.sql
    python3 scripts/run_sql.py --channel jdbc --jar /path/to/driver.jar FILE.sql
    python3 scripts/run_sql.py -e "SELECT 1"
    python3 scripts/run_sql.py --dry-run FILE.sql

Splits the script on semicolons (quote- and comment-aware), keeps a
multi-table COMPILE USL whole, fills in the user-agent placeholder from
ZETARIS_USER_AGENT, and stops at the first error. It never prints credentials.
Creating objects changes the instance, so use --dry-run first if unsure.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import zetaris_sql as z  # noqa: E402


def one_line(sql: str, n: int = 100) -> str:
    s = " ".join(sql.split())
    return s if len(s) <= n else s[: n - 3] + "..."


def format_progress_label(stmt: str, max_len: int = 26) -> str:
    s = " ".join(stmt.split())
    m = re.search(r"CREATE\s+LIGHTNING\s+REST\s+TABLE\s+([^\s]+)", s, re.IGNORECASE)
    if m:
        label = f"Table {m.group(1)}"
    else:
        m2 = re.search(r"CREATE\s+(?:LIGHTNING\s+)?(?:DATABASE|CONTAINER|TABLE|VIEW)\s+([^\s;]+)", s, re.IGNORECASE)
        if m2:
            label = m2.group(0)
        else:
            m3 = re.search(r"ACTIVATE\s+USL\s+TABLE\s+([^\s;]+)", s, re.IGNORECASE)
            if m3:
                parts = m3.group(1).split(".")
                label = f"Activate {parts[-1]}"
            else:
                label = s
    return label[:max_len]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("file", nargs="?", help="SQL file to run")
    p.add_argument("-e", "--execute", help="run this SQL text instead of a file")
    p.add_argument("--channel", choices=["rest", "jdbc"], default="rest")
    p.add_argument("--jar", help="JDBC driver JAR (or set ZETARIS_JDBC_JAR)")
    p.add_argument("--env-file", help="env file to load (default: .env.local in the repo root, or the top-level checkout for a worktree)")
    p.add_argument("--limit", type=int, default=20, help="max result rows to print per statement")
    p.add_argument("--skip-exists", action="store_true", help="treat 'already exists' errors as skipped, not failures")
    p.add_argument("--dry-run", action="store_true", help="print the statements without connecting")
    p.add_argument("--verbose", action="store_true", help="print every statement individually even when there are many")
    p.add_argument("--no-progress", action="store_true", help="disable progress bar")
    args = p.parse_args()

    if bool(args.file) == bool(args.execute):
        p.error("give either a SQL file or -e SQL")

    try:
        env = z.load_env(args.env_file)
        text = args.execute if args.execute else Path(args.file).read_text(encoding="utf-8")
        statements = z.split_statements(text)
        if not statements:
            raise z.ZetarisError("No SQL statements found.")

        if args.dry_run:
            try:
                statements = z.apply_user_agent(statements)
            except z.ZetarisError as e:
                print(f"warning: {e}", file=sys.stderr)
            if len(statements) > 10 and not args.verbose:
                for i in range(1, 6):
                    print(f"{i:>3}. {one_line(statements[i - 1])}")
                print(f"     ... ({len(statements) - 10} more statements) ...")
                for i in range(len(statements) - 4, len(statements) + 1):
                    print(f"{i:>3}. {one_line(statements[i - 1])}")
            else:
                for i, s in enumerate(statements, 1):
                    print(f"{i:>3}. {one_line(s)}")
            print(f"{len(statements)} statements (dry run, nothing sent)")
            return 0

        statements = z.apply_user_agent(statements)
        z.reexec_in_venv_if_needed(args.channel)
        print(f"channel={args.channel} env={env or 'process environment'} statements={len(statements)}")
        channel = z.open_channel(args.channel, args.jar)
    except (z.ZetarisError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    failed = skipped = 0
    i = 0
    t0 = time.time()
    use_progress = len(statements) > 10 and not args.verbose and not args.no_progress

    try:
        for i, stmt in enumerate(statements, 1):
            if use_progress:
                pct = (i / len(statements)) * 100
                elapsed = time.time() - t0

                # Check current terminal columns dynamically (handles real-time resizing)
                cols = shutil.get_terminal_size(fallback=(80, 24)).columns
                # Leave 1 char margin so console cursor never wraps past the right edge
                max_w = max(25, cols - 1)

                stats = f" {i:>3}/{len(statements)} ({pct:>5.1f}%) [{elapsed:>5.1f}s]"
                avail = max_w - len(stats) - 4  # space for "  [" and "] "

                if avail >= 15:
                    bar_len = min(20, max(5, avail // 3))
                    label_len = max(4, avail - bar_len - 1)
                    filled = int(bar_len * i // len(statements))
                    bar = "=" * filled + "-" * (bar_len - filled)
                    label = format_progress_label(stmt, max_len=label_len)
                    msg = f"  [{bar}] {label:<{label_len}}{stats}"
                elif avail >= 5:
                    bar_len = avail
                    filled = int(bar_len * i // len(statements))
                    bar = "=" * filled + "-" * (bar_len - filled)
                    msg = f"  [{bar}]{stats}"
                else:
                    msg = f"  {i}/{len(statements)} ({pct:.0f}%) [{elapsed:.0f}s]"

                # Clip strictly to max_w so it NEVER wraps regardless of window size
                msg = msg[:max_w]
                sys.stdout.write(f"\r{msg:<{max_w}}")
                sys.stdout.flush()
            else:
                print(f"{i:>3}. {one_line(stmt)}")

            try:
                result = channel.run(stmt, limit=args.limit)
            except z.ZetarisError as e:
                if args.skip_exists and z.ALREADY_EXISTS.search(str(e)):
                    skipped += 1
                    if not use_progress:
                        print("     skipped (already exists)")
                    continue
                failed += 1
                if use_progress:
                    sys.stdout.write("\n")
                print(f"     ERROR {e}", file=sys.stderr)
                break

            if result.rows:
                if use_progress:
                    sys.stdout.write("\n")
                for row in result.rows[: args.limit]:
                    print("     ", row)
                if len(result.rows) > args.limit:
                    print(f"      ... {len(result.rows) - args.limit} more rows")
    finally:
        if use_progress:
            cols = shutil.get_terminal_size(fallback=(80, 24)).columns
            max_w = max(25, cols - 1)
            sys.stdout.write(f"\r{' ' * max_w}\r")
            sys.stdout.flush()
        channel.close()

    ran = i - failed
    total_elapsed = time.time() - t0
    print(f"done: {ran}/{len(statements)} statements ok in {total_elapsed:.1f}s" + (f", {skipped} skipped" if skipped else "") + (", STOPPED on error" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
