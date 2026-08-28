#!/usr/bin/env python3
"""Reference implementation for the `.designate` v1 package format.

Independent-implementation viability (spec story 3.3.b): this file plus the
published test vectors are sufficient to consume `.designate` packages
without reading Designate's application source. Deliberately dependency-free
(stdlib only) and small, so a vendor can copy it into their own codebase.

A `.designate` file is an ordinary ZIP archive whose entries are STORED
(compression method 0). It contains the served parts (round.json, charts,
transcripts, ...) plus `manifest.json`, which lists every part with its
SHA-256. Verification is content-addressed: recompute each part's digest and
compare. The round document (`round.json`) is canonical JSON — keys sorted
recursively, two-space indentation, trailing newline — so byte equality is
semantic equality.

Usage:
    python designate_ref.py verify PACKAGE.designate
    python designate_ref.py vectors VECTORS_DIR

`verify` prints a verdict and exits 0 (intact) / 1 (not intact) / 2
(unreadable). `vectors` runs every vector directory (package.designate +
expected.json) and exits non-zero on any mismatch — the conformance gate.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

FORMAT_VERSION = "designate/1"
ROUND_DOCUMENT_KIND = "designate/1 round"
MANIFEST_PATH = "manifest.json"

# --------------------------------------------------------------------------
# Container: STORE-only zip reader (local file headers walked front to back).
# Compressed entries are refused — the container is meant to be auditable
# with a hex editor, and stored bytes keep digests trivially recomputable.
# --------------------------------------------------------------------------


def unzip_store(data: bytes) -> list[tuple[str, bytes]] | None:
    parts: list[tuple[str, bytes]] = []
    at = 0
    while at + 4 <= len(data) and data[at : at + 4] == b"PK\x03\x04":
        if at + 30 > len(data):
            return None
        (method,) = struct.unpack_from("<H", data, at + 8)
        (size,) = struct.unpack_from("<I", data, at + 18)
        (name_len,) = struct.unpack_from("<H", data, at + 26)
        (extra_len,) = struct.unpack_from("<H", data, at + 28)
        if method != 0:
            return None  # compressed entry: not a conforming container
        name_start = at + 30
        data_start = name_start + name_len + extra_len
        if data_start + size > len(data):
            return None
        name = data[name_start : name_start + name_len].decode("utf-8", "replace")
        parts.append((name, data[data_start : data_start + size]))
        at = data_start + size
    return parts if parts else None


# --------------------------------------------------------------------------
# Manifest verification — mirrors the app's verifyDesignatePackage: every
# failure mode is a verdict, never an exception.
# --------------------------------------------------------------------------


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_manifest(parts: list[tuple[str, bytes]]) -> tuple[bool, bool]:
    """Returns (readable, intact)."""
    by_path = dict(parts)
    raw = by_path.get(MANIFEST_PATH)
    if raw is None:
        return (False, False)
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return (False, False)
    listed = manifest.get("parts")
    if manifest.get("format") != FORMAT_VERSION or not isinstance(listed, list):
        return (False, False)
    intact = True
    listed_paths = set()
    for entry in listed:
        if not isinstance(entry, dict):
            return (False, False)
        path, digest = entry.get("path"), entry.get("sha256")
        if not isinstance(path, str) or not isinstance(digest, str):
            return (False, False)
        listed_paths.add(path)
        got = by_path.get(path)
        if got is None or sha256_hex(got) != digest:
            intact = False  # missing or modified
    for path, _ in parts:
        if path != MANIFEST_PATH and path not in listed_paths:
            intact = False  # unlisted extra part
    return (True, intact)


# --------------------------------------------------------------------------
# Round document checks — the required sections. Unknown TOP-LEVEL keys are
# non-fatal (forward compatibility); unknown keys under `extensions` are the
# documented extension slot. Every problem is a sentence, not a code.
# --------------------------------------------------------------------------


def check_round_document(raw: bytes | None) -> list[str]:
    if raw is None:
        return ["round.json missing"]
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ["round.json is not valid JSON"]
    problems: list[str] = []
    if doc.get("kind") != ROUND_DOCUMENT_KIND:
        problems.append(f'kind must be "{ROUND_DOCUMENT_KIND}"')
    round_ = doc.get("round")
    if not isinstance(round_, dict) or not isinstance(round_.get("id"), str):
        problems.append("round section missing")
    if not isinstance(doc.get("transcripts"), list):
        problems.append("transcripts section missing")
    if not isinstance(doc.get("designations"), list):
        problems.append("designations section missing")
    verification = doc.get("verification")
    if not isinstance(verification, dict) or not isinstance(verification.get("spec"), str):
        problems.append("verification section missing")
    extensions = doc.get("extensions")
    if extensions is not None and not isinstance(extensions, dict):
        problems.append("extensions must be an object")
    for seg in doc.get("designations") or []:
        cite = seg.get("cite") if isinstance(seg, dict) else None
        if not isinstance(cite, str) or not cite:
            seg_id = seg.get("id", "?") if isinstance(seg, dict) else "?"
            problems.append(f"designation {seg_id} has no qualified cite")
            break
    return problems


def verdict(package: bytes) -> dict:
    parts = unzip_store(package)
    if parts is None:
        return {"readable": False, "intact": False, "docProblems": []}
    readable, intact = verify_manifest(parts)
    round_raw = dict(parts).get("round.json")
    return {
        "readable": readable,
        "intact": intact,
        "docProblems": check_round_document(round_raw),
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def run_vectors(vectors_dir: Path) -> int:
    failures = 0
    dirs = sorted(p for p in vectors_dir.iterdir() if p.is_dir())
    if not dirs:
        print(f"no vectors found under {vectors_dir}")
        return 2
    for d in dirs:
        package = (d / "package.designate").read_bytes()
        expected = json.loads((d / "expected.json").read_text(encoding="utf-8"))
        got = verdict(package)
        want = {k: expected[k] for k in ("readable", "intact", "docProblems")}
        ok = got == want
        print(f"{'PASS' if ok else 'FAIL'}  {d.name}")
        if not ok:
            failures += 1
            print(f"      want {want}")
            print(f"      got  {got}")
    print(f"\n{len(dirs) - failures}/{len(dirs)} vectors pass")
    return 0 if failures == 0 else 1


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "verify":
        v = verdict(Path(argv[2]).read_bytes())
        print(json.dumps(v, indent=2))
        if not v["readable"]:
            return 2
        return 0 if v["intact"] and not v["docProblems"] else 1
    if len(argv) == 3 and argv[1] == "vectors":
        return run_vectors(Path(argv[2]))
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
