"""Offline regression checks for Zetaris REST authentication and token refresh.

The access token returned by /api/auth/login is short lived (about an hour).
Storing it as ZETARIS_API_KEY and never refreshing it means every unattended job
starts failing roughly an hour after a human last logged in, and the failure
surfaces only as HTTP 400 Bad Request.
"""

import base64
import io
import json
import os
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import zetaris_sql as z

LOGIN_URL = "http://ui.invalid/api/auth/login"
REST_URL = "http://rest.invalid/api/v1.0"


def jwt(expires_in: int) -> str:
    """A token whose exp is `expires_in` seconds from now."""
    payload = {"exp": int(time.time()) + expires_in}
    encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return ".".join(
        [
            encode(json.dumps({"alg": "none"}).encode()),
            encode(json.dumps(payload).encode()),
            "signature",
        ]
    )


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def http_error(code: int) -> HTTPError:
    return HTTPError(REST_URL, code, "Bad Request", {}, io.BytesIO(b"Bad Request"))


class RestAuthTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(
            os.environ,
            {
                "ZETARIS_REST_URL": REST_URL,
                "ZETARIS_BASE_URL": "http://ui.invalid",
                "ZETARIS_ORG_ID": "1",
            },
            clear=True,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.logins = 0
        self.calls = []

    def fake_urlopen(self, api_responses):
        """Serve logins, then hand out `api_responses` to REST calls in order."""
        remaining = list(api_responses)

        def opener(req, timeout=None):
            url = req.full_url
            self.calls.append(url)
            if url == LOGIN_URL:
                self.logins += 1
                return FakeResponse(
                    json.dumps({"idToken": jwt(3600), "orgId": 1}).encode()
                )
            outcome = remaining.pop(0)
            if isinstance(outcome, HTTPError):
                raise outcome
            return FakeResponse(json.dumps(outcome).encode())

        return opener

    def test_mints_a_token_when_only_credentials_are_configured(self):
        os.environ.update(
            {"ZETARIS_USERNAME": "admin@example.com", "ZETARIS_PASSWORD": "secret"}
        )
        with patch.object(z, "urlopen", self.fake_urlopen([{"data": [[1]]}])):
            channel = z.RestChannel()
            result = channel.run("SELECT 1")
        self.assertEqual(self.logins, 1)
        self.assertEqual(result.rows, [[1]])

    def test_refuses_clearly_when_neither_key_nor_credentials_are_configured(self):
        with self.assertRaises(z.ZetarisError) as caught:
            z.RestChannel()
        message = str(caught.exception)
        self.assertIn("ZETARIS_API_KEY", message)
        self.assertIn("ZETARIS_USERNAME", message)

    def test_refreshes_an_already_expired_stored_token_before_calling(self):
        os.environ.update(
            {
                "ZETARIS_API_KEY": jwt(-60),
                "ZETARIS_USERNAME": "admin@example.com",
                "ZETARIS_PASSWORD": "secret",
            }
        )
        with patch.object(z, "urlopen", self.fake_urlopen([{"data": [[1]]}])):
            z.RestChannel().run("SELECT 1")
        # Minted up front rather than waiting for the request to be rejected.
        self.assertEqual(self.logins, 1)
        self.assertNotIn(LOGIN_URL, self.calls[1:])

    def test_keeps_a_valid_stored_token_without_logging_in(self):
        os.environ.update({"ZETARIS_API_KEY": jwt(3600)})
        with patch.object(z, "urlopen", self.fake_urlopen([{"data": [[1]]}])):
            z.RestChannel().run("SELECT 1")
        self.assertEqual(self.logins, 0)

    def test_refreshes_once_and_retries_when_the_server_rejects_the_token(self):
        os.environ.update(
            {
                "ZETARIS_API_KEY": jwt(3600),
                "ZETARIS_USERNAME": "admin@example.com",
                "ZETARIS_PASSWORD": "secret",
            }
        )
        responses = [http_error(401), {"data": [[7]]}]
        with patch.object(z, "urlopen", self.fake_urlopen(responses)):
            result = z.RestChannel().run("SELECT 1")
        self.assertEqual(self.logins, 1)
        self.assertEqual(result.rows, [[7]])

    def test_does_not_retry_forever_when_the_refresh_does_not_help(self):
        os.environ.update(
            {
                "ZETARIS_API_KEY": jwt(3600),
                "ZETARIS_USERNAME": "admin@example.com",
                "ZETARIS_PASSWORD": "secret",
            }
        )
        responses = [http_error(401), http_error(401)]
        with patch.object(z, "urlopen", self.fake_urlopen(responses)):
            with self.assertRaises(z.ZetarisError):
                z.RestChannel().run("SELECT 1")
        self.assertEqual(self.logins, 1)

    def test_a_bad_sql_400_with_a_valid_token_does_not_trigger_a_login(self):
        # 400 also means "bad SQL". With a token that is demonstrably still
        # valid there is nothing to refresh, so no spurious login is spent.
        os.environ.update(
            {
                "ZETARIS_API_KEY": jwt(3600),
                "ZETARIS_USERNAME": "admin@example.com",
                "ZETARIS_PASSWORD": "secret",
            }
        )
        with patch.object(z, "urlopen", self.fake_urlopen([http_error(400)])):
            with self.assertRaises(z.ZetarisError):
                z.RestChannel().run("SELECT nonsense FROM nowhere")
        self.assertEqual(self.logins, 0)

    def test_an_auth_failure_without_credentials_names_expiry_as_the_cause(self):
        os.environ.update({"ZETARIS_API_KEY": jwt(3600)})
        with patch.object(z, "urlopen", self.fake_urlopen([http_error(401)])):
            with self.assertRaises(z.ZetarisError) as caught:
                z.RestChannel().run("SELECT 1")
        self.assertIn("expired", str(caught.exception).lower())

    def test_the_password_never_appears_in_an_error(self):
        os.environ.update(
            {"ZETARIS_USERNAME": "admin@example.com", "ZETARIS_PASSWORD": "hunter2"}
        )

        def failing(req, timeout=None):
            raise HTTPError(LOGIN_URL, 401, "Unauthorized", {}, io.BytesIO(b"hunter2"))

        with patch.object(z, "urlopen", failing):
            with self.assertRaises(z.ZetarisError) as caught:
                z.RestChannel()
        self.assertNotIn("hunter2", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
