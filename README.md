# The `.designate` format — v1 specification

**Status:** v1.0.0-draft · semver · maintained separately from any application that writes it.
**Canonical home:** `spec.designate.legal/v1` (this repository is the source).
**One sentence:** *the exchange itself is a verifiable record* — a `.designate` package carries a served designation round together with everything a recipient needs to verify it, including a recipient who has never run Designate and never will.

## 1. Container

A `.designate` file is an ordinary **ZIP archive** with every entry **STORED** (compression method 0, deterministic fixed timestamps). The container is meant to be auditable with a hex editor, and stored bytes keep digests trivially recomputable. Alongside the served parts it always contains **`manifest.json`**:

```json
{
  "format": "designate/1",
  "caseName": "…",
  "producedAt": "2026-08-27T12:00:00.000Z",
  "producedBy": "…",
  "parts": [ { "path": "round.json", "bytes": 1234, "sha256": "…" } ]
}
```

### Container rules (normative)

A verifier hashes the bytes it walked; a general-purpose unzipper extracts by the central directory. The two MUST agree, or the verdict would describe different bytes than the recipient's `unzip -o` produced. A conforming package satisfies all of the following, and a conforming reader MUST refuse — not partially read — a package that violates any one of them:

1. **Stored only.** Every entry uses compression method 0, and each local header's compressed and uncompressed sizes are equal.
2. **Unique names.** No two entries share a name.
3. **CRC-32 per entry.** Each entry's bytes MUST match the CRC-32 recorded in its local header.
4. **Central directory mirrors the entries.** The central directory MUST list exactly the local headers walked, in order; each central entry's local-header offset, CRC-32, sizes and name MUST match the local header it points at.
5. **End record closes the file.** The end-of-central-directory record MUST count exactly the entries walked, MUST point at the central directory (offset and size), and MUST be the last thing in the file — nothing follows it and its comment.

Refusal is a verdict, not a crash: a non-conforming container reports `readable: false, intact: false` with no document problems (vectors 14 and 23–26). These packages were never valid `.designate` files; the rules name what a STORE-only zip was always assumed to be.

**Verification is content-addressed:** recompute each part's SHA-256 and compare against the manifest. A part whose digest differs is *modified*; a listed part absent from the archive is *missing*; an archive entry the manifest never listed is *unlisted*. Any of the three means the package is **not intact**. Manifest `parts` are sorted by `path` at build time; verification is order-insensitive.

## 2. The round document (`round.json`)

The flagship part of a **round package** (`"kind": "designate/1 round"`) — one served designation round. JSON Schema: [`schema/round.schema.json`](schema/round.schema.json). Sections:

| Section | Contents |
|---|---|
| `round` | id, `direction` (inbound/outbound from the producer's perspective), servedAt, sourceKind (filing/paste/csv/designate), prevRoundId linkage |
| `transcripts` | per-deposition identity: title, deponent, active version + **content SHA-256**, page/line counts, full **version lineage** (rough → final, ascending), and **timing provenance** (`source`: uploaded / aligned / estimated; covered vs total lines; upload file digests) |
| `designations` | each served designation: party + role vocabulary, **qualified cite** (page:line with word-anchor qualifiers for partial lines), page/line bounds, **UTF-16 code-unit offsets** (`startOffset`/`endOffset`, null = whole line), excerpt, objection basis / response, **canonical ruling** (`""`, `reserved`, `sustained`, `overruled`), counter/reply links by designation id, filed-artifact reference |
| `filings` | filed-artifact provenance: ECF number, title, side, kind |
| `recipes` | export-recipe references relevant to the round (producers MAY include; empty is valid) |
| `auditEvents` | the producer's **hash-chained audit slice** for this round: consecutive events link `prevEventHash → eventHash`; empty when the producer built offline |
| `verification` | how to verify: `manifest: "sha256-per-part"`, the chain rule, and the spec URL for this version |
| `extensions` | forward-compatible vendor slot — see §4 |

### Offset contract

Text offsets are **UTF-16 code units** into the referenced line's text — the JavaScript string convention, chosen so browser and non-browser implementations agree without grapheme segmentation. `null` means the boundary is the whole line. A partial-line designation's cite MUST carry the word-anchor qualifier (e.g. `12:05(after "Yes")-12:09`) so the citation is meaningful on paper as well as in software.

## 3. Canonicalization

See [`canonicalization.md`](canonicalization.md). Summary: `round.json` is serialized with **keys sorted recursively**, two-space indentation, `\n` newlines, and a trailing newline; arrays are sorted by the rules in that document (designations by deposition → position → id; lineage by versionNo; audit events by createdAt). Two documents with equal content are therefore **byte-equal**, and the manifest digest of `round.json` is a semantic fingerprint.

## 4. Versioning and forward compatibility

- **Semver.** Breaking changes require a major bump (`designate/2`). This repo tags releases.
- **Unknown top-level keys MUST be ignored** by consumers (non-fatal). Machine-readable vendor extensions belong under `extensions`, with namespaced keys (`vendor.example/field`); consumers MUST ignore unknown extension keys and SHOULD surface their presence as informational.
- **Every field carries a `deprecated_in` slot in the schema changelog; silent removal is prohibited.** Deprecated fields keep being written for one major version.

## 5. Verification rules (normative)

A conforming verifier reports, in order:
1. **readable** — the archive is a conforming container (§1 container rules) and `manifest.json` parses with `format: "designate/1"`.
2. **intact** — every listed part present with a matching SHA-256, and no unlisted parts.
3. **document problems** — `round.json` present, valid JSON, correct `kind`, required sections present (`round`, `transcripts`, `designations`, `verification`), every designation carrying a non-empty qualified cite, `extensions` an object when present.

Failure modes are verdicts, never crashes. The [reference implementation](reference/designate_ref.py) (stdlib-only Python, MIT) and the [test vectors](vectors/) are jointly normative: an independent implementation that reproduces every vector's `expected.json` conforms.

## 6. Test vectors

[`vectors/`](vectors/) contains ≥ 20 packages with pinned verdicts (`expected.json`), covering happy paths (minimal, full, multi-party, offsets, rulings, outbound, extensions, large) and failure paths (missing manifest, tampered part, missing/unlisted parts, non-zip, duplicate entry, CRC-32 mismatch, re-pointed central directory, bytes after the end record, malformed and non-conforming documents). Run them against any implementation:

```
python reference/designate_ref.py vectors vectors
```

## 7. Validator

[`validator/v1/`](validator/v1/) is the free web validator/viewer — a static, dependency-vendored page (no backend, no accounts, no telemetry): drop a `.designate` file and it parses **in your browser**, shows per-part checksum verdicts, party rounds, unknown-extension notices, and offers a rendered-PDF fallback for anyone who just wants to read the round. Its core (`designate-core.mjs`) is the third independent implementation of the format, pinned to the same vectors in CI. Hosted at `verify.designate.legal`.

## 8. License

Reference implementation and schema: MIT. The specification text may be reproduced with attribution.
