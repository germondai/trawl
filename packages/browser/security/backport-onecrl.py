#!/usr/bin/env python3
"""Backport bundled OneCRL enforcement to the pinned Camoufox 152.0.4 build.

Startup import adapted from Mozilla Bug 2084311 and Camoufox commit
809d08cf0bd6df5985e42153d5e72cab7a68734a (MPL-2.0).
Revocation records are Mozilla's six eMudhra entries for Bug 2083382,
copied from the same commit. Remove this backport after a compatible browser
ships both the updated bundle and its startup import.
"""

import hashlib
import json
from pathlib import Path
import sys
from zipfile import ZipFile


MODULE = "modules/psm/RemoteSecuritySettings.sys.mjs"
BUNDLE = "defaults/settings/security-state/onecrl.json"
MANIFEST = "components/components.manifest"
MARKER = '    this.OneCRLBlocklistClient.on("sync", updateCertBlocklist);'
IMPORT = """
    // Load the bundled list even when Remote Settings is disabled.
    this.OneCRLBlocklistClient.get()
      .then(records => updateCertBlocklist({
        data: { current: records, created: records, updated: [], deleted: [] },
      }))
      .catch(e => lazy.log.error(e));
"""
# Idle startup waits for a window, and pooled browsers have none until a request opens a page.
IDLE_INIT = "category browser-idle-startup resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs RemoteSecuritySettings.init"
EARLY_INIT = IDLE_INIT.replace("browser-idle-startup", "browser-before-ui-startup")


def rewrite(archive: Path, patches: dict) -> Path:
    """Write a patched copy of archive next to it and return its path."""
    temporary = archive.with_suffix(".patched")
    try:
        with ZipFile(archive) as source:
            replacements = {}
            for name, (expected_hash, transform) in patches.items():
                if source.namelist().count(name) != 1:
                    raise ValueError(f"Expected exactly one {name} in {archive}")
                original = source.read(name)
                if hashlib.sha256(original).hexdigest() != expected_hash:
                    raise ValueError(f"Unexpected pinned browser resource: {name}")
                replacements[name] = transform(original)
            with ZipFile(temporary, "w") as target:
                target.comment = source.comment
                for entry in source.infolist():
                    data = replacements[entry.filename] if entry.filename in replacements else source.read(entry)
                    target.writestr(entry, data)
        temporary.chmod(archive.stat().st_mode)
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def replace_once(data: bytes, old: str, new: str) -> bytes:
    source = data.decode()
    if source.count(old) != 1:
        raise ValueError(f"Expected one occurrence of: {old.strip()}")
    return source.replace(old, new).encode()


def patch_module(data: bytes) -> bytes:
    return replace_once(data, MARKER, MARKER + IMPORT)


def patch_manifest(data: bytes) -> bytes:
    return replace_once(data, IDLE_INIT, EARLY_INIT)


def patch_bundle(data: bytes) -> bytes:
    bundle = json.loads(data)
    records = json.loads(Path(__file__).with_name("emudhra-onecrl.json").read_text())
    ids = {record["id"] for record in records}
    bundle["data"] = records + [record for record in bundle["data"] if record["id"] not in ids]
    bundle["timestamp"] = max(bundle["timestamp"], *(record["last_modified"] for record in records))
    return (json.dumps(bundle, indent=2) + "\n").encode()


PATCHES = {
    "omni.ja": {
        MODULE: ("85a5bda5150ac35af83476023e35ebc5025aba2e6a6659b479d5989b6ce73c6c", patch_module),
    },
    "browser/omni.ja": {
        BUNDLE: ("d10b4a4a4d248a8849cb64621f2be17f29a2542eedd9d8ea5aa9028d2db9c986", patch_bundle),
        MANIFEST: ("bedf20f7f83a1528410fabb230ed785aa51e13ce10b140315d210db2d493d984", patch_manifest),
    },
}


def backport(root: Path):
    # Validate and write every archive before replacing any.
    staged = []
    try:
        for name, patches in PATCHES.items():
            staged.append((root / name, rewrite(root / name, patches)))
        for archive, temporary in staged:
            temporary.replace(archive)
    finally:
        for _, temporary in staged:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    backport(Path(sys.argv[1]))
