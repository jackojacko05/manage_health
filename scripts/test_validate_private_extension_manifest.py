from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from validate_private_extension_manifest import MANIFEST, validate


class PrivateExtensionManifestTest(unittest.TestCase):
    def test_checked_in_manifest_is_valid(self) -> None:
        self.assertEqual(validate(MANIFEST), [])

    def test_public_repository_cannot_change(self) -> None:
        payload = json.loads(MANIFEST.read_text(encoding="utf-8"))
        payload["public_repository"] = "private/example"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            errors = validate(path)
        self.assertTrue(any("public_repository" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
