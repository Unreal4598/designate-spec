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
import zlib
from pathlib import Path

FORMAT_VERSION = "designate/1"
ROUND_DOCUMENT_KIND = "designate/1 round"
MANIFEST_PATH = "manifest.json"

# --------------------------------------------------------------------------
# Container: STORE-only zip reader. Local file headers are walked front to
# back, then the central directory and end record are cross-checked against
# them (spec README §1, container rules). Refused (None): compressed entries,
# duplicate names, a CRC-32 that does not match its bytes, a central directory
# that does not list exactly the walked entries in order, an end record whose
# counts/offset/size disagree, and any bytes after it — each is a container
# where `unzip -o` could extract different bytes than the ones hashed here.
# --------------------------------------------------------------------------


def unzip_store(data: bytes) -> list[tuple[str, bytes]] | None:
    parts: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    local_offsets: list[int] = []
    at = 0
    while at + 4 <= len(data) and data[at : at + 4] == b"PK\x03\x04":
        if at + 30 > len(data):
            return None
        local_offsets.append(at)
        # method, mtime, mdate, crc32, compressed size, uncompressed size, name len, extra len
        method, _, _, crc, size, full_size, name_len, extra_len = struct.unpack_from("<HHHIIIHH", data, at + 8)
        if method != 0 or full_size != size:
            return None  # compressed entry (or sizes disagree): not a conforming container
        name_start = at + 30
        data_start = name_start + name_len + extra_len
        if data_start + size > len(data):
            return None
        name = data[name_start : name_start + name_len].decode("utf-8", "replace")
        payload = data[data_start : data_start + size]
        if name in seen or zlib.crc32(payload) != crc:
            return None  # duplicate name, or bytes that do not match their CRC-32
        seen.add(name)
        parts.append((name, payload))
        at = data_start + size
    if not parts:
        return None

    # Central directory: one header per walked entry, in order, pointing at the
    # local header walked with the same name, CRC-32 and sizes.
    cd_start = at
    listed = 0
    while at + 4 <= len(data) and data[at : at + 4] == b"PK\x01\x02":
        if at + 46 > len(data) or listed >= len(parts):
            return None
        name, payload = parts[listed]
        # crc32, compressed size, uncompressed size, name len, extra len, comment len
        crc, size, full_size, name_len, extra_len, comment_len = struct.unpack_from("<IIIHHH", data, at + 16)
        (offset,) = struct.unpack_from("<I", data, at + 42)
        if at + 46 + name_len > len(data):
            return None
        if offset != local_offsets[listed] or crc != zlib.crc32(payload):
            return None
        if size != len(payload) or full_size != len(payload):
            return None
        if data[at + 46 : at + 46 + name_len].decode("utf-8", "replace") != name:
            return None
        at += 46 + name_len + extra_len + comment_len
        listed += 1
    if listed != len(parts):
        return None

    # End of central directory: points at the CD just validated, counts exactly
    # the entries walked, and is the last thing in the file (comment included).
    if at + 22 > len(data) or data[at : at + 4] != b"PK\x05\x06":
        return None
    # entries on this disk, entries total, cd size, cd offset, comment len
    count, total, cd_size, cd_offset, comment_len = struct.unpack_from("<HHIIH", data, at + 8)
    if cd_offset != cd_start or cd_size != at - cd_start:
        return None
    if count != len(parts) or total != len(parts):
        return None
    if at + 22 + comment_len != len(data):
        return None
    return parts


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
