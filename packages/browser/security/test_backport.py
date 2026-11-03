import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile


spec = importlib.util.spec_from_file_location("backport", Path(__file__).with_name("backport-onecrl.py"))
backport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backport)


class BackportTests(unittest.TestCase):
    def test_preserves_other_revocations_and_is_idempotent(self):
        previous = {"id": "previous", "enabled": True}
        original = json.dumps({"data": [previous], "timestamp": 1}).encode()
        patched = backport.patch_bundle(original)
        bundle = json.loads(patched)
        self.assertIn(previous, bundle["data"])
        self.assertEqual(len(bundle["data"]), 7)
        self.assertEqual(backport.patch_bundle(patched), patched)
        self.assertTrue(all(record["enabled"] for record in bundle["data"]))

    def test_unexpected_source_leaves_every_archive_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "browser").mkdir()
            with ZipFile(root / "omni.ja", "w") as target:
                target.writestr(backport.MODULE, backport.MARKER)
            with ZipFile(root / "browser/omni.ja", "w") as target:
                target.writestr(backport.MANIFEST, "unexpected source")
            original = {name: (root / name).read_bytes() for name in backport.PATCHES}
            pinned = hashlib.sha256(backport.MARKER.encode()).hexdigest()
            patches = {
                "omni.ja": {backport.MODULE: (pinned, backport.patch_module)},
                "browser/omni.ja": {backport.MANIFEST: (pinned, backport.patch_manifest)},
            }
            with mock.patch.object(backport, "PATCHES", patches):
                with self.assertRaisesRegex(ValueError, "Unexpected pinned browser"):
                    backport.backport(root)
            self.assertEqual({name: (root / name).read_bytes() for name in original}, original)
            self.assertEqual(list(root.rglob("*.patched")), [])

    def test_rewrite_preserves_unrelated_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "omni.ja"
            module, manifest = backport.MARKER.encode(), backport.IDLE_INIT.encode()
            with ZipFile(archive, "w") as target:
                target.writestr(backport.MODULE, module)
                target.writestr(backport.MANIFEST, manifest)
                target.writestr("unrelated", b"unchanged")
            patched = backport.rewrite(archive, {
                backport.MODULE: (hashlib.sha256(module).hexdigest(), backport.patch_module),
                backport.MANIFEST: (hashlib.sha256(manifest).hexdigest(), backport.patch_manifest),
            })
            with ZipFile(patched) as target:
                self.assertEqual(target.read("unrelated"), b"unchanged")
                self.assertIn(b"OneCRLBlocklistClient.get()", target.read(backport.MODULE))
                self.assertEqual(target.read(backport.MANIFEST), backport.EARLY_INIT.encode())


if __name__ == "__main__":
    unittest.main()
