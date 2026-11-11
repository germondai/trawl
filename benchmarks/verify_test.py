import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from run import main, verify


class ContentVerification(unittest.TestCase):
    target = {
        "url": "https://example.test/catalog/item",
        "expected": "<title>Catalog item</title>",
        "expectedPaths": ["/catalog/item"],
    }

    def response(self, url="https://example.test/catalog/item", html=None):
        return {"status": "ok", "solution": {
            "status": 200, "url": url,
            "response": html or "<html><title>Catalog item</title><body>Product details</body></html>",
        }}

    def test_content_at_intended_destination(self):
        self.assertTrue(verify(self.target, 200, self.response()))

    def test_unrelated_destination_with_matching_content(self):
        for url in ["https://example.test/landing", "https://other.test/catalog/item", ""]:
            with self.subTest(url=url):
                self.assertFalse(verify(self.target, 200, self.response(url)))

    def test_documented_redirect(self):
        target = {**self.target, "expectedPaths": ["/catalog/item", "/catalog"]}
        self.assertTrue(verify(target, 200, self.response("https://example.test/catalog")))

    def test_matching_brand_on_a_wall_is_not_success(self):
        html = '<title>Catalog item</title><form id="challenge-form">Checking your browser</form>'
        self.assertFalse(verify(self.target, 200, self.response(html=html)))

    def test_selected_product_does_not_require_competitor_images(self):
        inspected = []

        def docker(*args):
            if args[:2] == ("image", "inspect"):
                inspected.append(args[2])
                if args[2] != "fixture:local":
                    raise AssertionError("Unselected competitor image was inspected")
                return json.dumps([{"Id": "fixture", "Size": 1, "Architecture": "arm64"}])
            if args[0] == "run":
                raise RuntimeError("Stop before starting Redis")
            return ""

        with TemporaryDirectory() as folder:
            targets = Path(folder) / "targets.json"
            targets.write_text("[]")
            argv = ["run.py", "--trawl-image", "fixture:local", "--output", str(Path(folder) / "output"),
                    "--targets", str(targets), "--products", "trawl", "--session-products"]
            with patch("sys.argv", argv), patch("run.docker", side_effect=docker), patch("run.subprocess.run") as run:
                run.return_value.returncode = 1
                with self.assertRaisesRegex(RuntimeError, "Stop before starting Redis"):
                    main()
            self.assertEqual(inspected, ["fixture:local"])


if __name__ == "__main__":
    unittest.main()
