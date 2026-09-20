# Canonicalization rules — `.designate` v1

Two round documents with equal content MUST be byte-equal. Producers achieve
this with the following rules; consumers MAY rely on them (e.g. hashing
`round.json` as a semantic fingerprint).

## JSON serialization

1. Object keys sorted lexicographically (code-unit order), **recursively**.
2. Two-space indentation, `\n` line endings, one trailing `\n`.
3. UTF-8 encoding, no BOM.
4. Numbers as shortest round-trip decimal (JavaScript `JSON.stringify`
   semantics); no `+`, no leading zeros, no trailing `.0`.
5. No NaN/Infinity — absent measurements are `null` or omitted.

## Array ordering

| Array | Order |
|---|---|
| `transcripts` | `depositionId` ascending |
| `transcripts[].lineage` | `versionNo` ascending (rough → final) |
| `transcripts[].timing.uploads` | `contentSha256` ascending |
| `designations` | `depositionId`, then `startPage`, then `startLine`, then `id` |
| `filings` | `id` ascending |
| `auditEvents` | `createdAt` ascending, then `eventHash` |
| `manifest.parts` | `path` ascending |

## Container determinism

ZIP entries are STORED with fixed DOS timestamps (1980-01-01). Identical
parts therefore produce a byte-identical archive. `producedAt` in the
manifest is an **input** supplied by the producer, never sampled from the
clock at serialization time — reproducing a package with the same inputs
yields the same bytes.

Determinism also means a package has exactly one reading. A producer MUST
write entries with unique names, a correct CRC-32 per entry, a central
directory that lists the local headers exactly and in order, and an
end-of-central-directory record that closes the file (README §1, container
rules). A reader MUST refuse a package where a central-directory-driven
extractor could produce different bytes than a front-to-back walk of the
local headers: duplicate names, a CRC-32 mismatch, a central entry pointing
at another entry's header, counts or offsets that disagree, or bytes after
the end record. Such a package has no canonical content to hash.
