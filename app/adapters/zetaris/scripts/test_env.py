"""Offline regression checks for shared Haze environment configuration."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import zetaris_sql as z


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="haze-env-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.adapter = self.root / "app/adapters/zetaris"
        self.adapter.mkdir(parents=True)
        self.env_patch = patch.dict(os.environ, {}, clear=True)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.root_patch = patch.object(z, "PROJECT_ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def test_root_and_process_values_win_while_legacy_fills_missing_keys(self):
        (self.root / ".env").write_text(
            'HAZE_ENV_TEST_ROOT=root\nHAZE_ENV_TEST_PROCESS=root\nHAZE_ENV_TEST_EMPTY=\n'
            'HAZE_ENV_TEST_QUOTED="a value with spaces"\n', encoding="utf-8"
        )
        (self.adapter / ".env.local").write_text(
            "HAZE_ENV_TEST_ROOT=legacy\nHAZE_ENV_TEST_PROCESS=legacy\n"
            "HAZE_ENV_TEST_EMPTY=legacy\nHAZE_ENV_TEST_LEGACY=legacy\n", encoding="utf-8"
        )
        os.environ["HAZE_ENV_TEST_PROCESS"] = "process"
        self.assertEqual(z.load_env(), self.root / ".env")
        self.assertEqual(os.environ["HAZE_ENV_TEST_ROOT"], "root")
        self.assertEqual(os.environ["HAZE_ENV_TEST_PROCESS"], "process")
        self.assertEqual(os.environ["HAZE_ENV_TEST_EMPTY"], "")
        self.assertEqual(os.environ["HAZE_ENV_TEST_LEGACY"], "legacy")
        self.assertEqual(os.environ["HAZE_ENV_TEST_QUOTED"], "a value with spaces")

    def test_existing_adapter_file_works_without_root_env(self):
        legacy = self.adapter / ".env.local"
        legacy.write_text("HAZE_ENV_TEST_LEGACY=legacy\n", encoding="utf-8")
        self.assertEqual(z.load_env(), legacy)
        self.assertEqual(os.environ["HAZE_ENV_TEST_LEGACY"], "legacy")

    def test_explicit_env_file_is_used_alone(self):
        (self.root / ".env").write_text("HAZE_ENV_TEST_ROOT=root\n", encoding="utf-8")
        custom = self.root / "custom.env"
        custom.write_text("HAZE_ENV_TEST_EXPLICIT=custom\n", encoding="utf-8")
        self.assertEqual(z.load_env(str(custom)), custom)
        self.assertEqual(os.environ["HAZE_ENV_TEST_EXPLICIT"], "custom")
        self.assertNotIn("HAZE_ENV_TEST_ROOT", os.environ)

    def test_worktree_finds_main_checkout_before_legacy_values(self):
        main = self.root / "main"
        pointer = main / ".git/worktrees/test"
        pointer.mkdir(parents=True)
        (self.root / ".git").write_text("gitdir: main/.git/worktrees/test\n", encoding="utf-8")
        (main / ".env").write_text("HAZE_ENV_TEST_ROOT=main\n", encoding="utf-8")
        (self.adapter / ".env.local").write_text("HAZE_ENV_TEST_ROOT=legacy\n", encoding="utf-8")
        self.assertEqual(z.load_env(), main / ".env")
        self.assertEqual(os.environ["HAZE_ENV_TEST_ROOT"], "main")
        (self.root / ".env").write_text("HAZE_ENV_TEST_ROOT=worktree\n", encoding="utf-8")
        del os.environ["HAZE_ENV_TEST_ROOT"]
        self.assertEqual(z.load_env(), self.root / ".env")
        self.assertEqual(os.environ["HAZE_ENV_TEST_ROOT"], "worktree")


if __name__ == "__main__":
    unittest.main()
