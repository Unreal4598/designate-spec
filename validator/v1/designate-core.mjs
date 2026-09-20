// Validator core for `.designate` v1 — runs unchanged in the browser (the
// verify.designate.legal page) and in Node (the CI vector runner). No
// dependencies; WebCrypto for digests. This is the third independent
// implementation of the format (app TypeScript, reference Python, this) —
// all three are pinned to the same published test vectors.

export const FORMAT_VERSION = "designate/1";
export const ROUND_DOCUMENT_KIND = "designate/1 round";
const MANIFEST_PATH = "manifest.json";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** STORE-only zip reader: local file headers walked front to back, then the
 *  central directory and end record cross-checked against them (spec README
 *  §1, container rules). Refused (null): compressed entries, duplicate names,
 *  a CRC-32 that does not match its bytes, a central directory that does not
 *  list exactly the walked entries in order (offset, CRC, sizes, name), an
 *  end record whose counts/offset/size disagree, and any bytes after it —
 *  each is a container where `unzip -o` could extract different bytes than
 *  the ones hashed here. */
export function unzipStore(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const parts = [];
  const seen = new Set();
  const localOffsets = [];
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    if (at + 30 > bytes.length) return null;
    localOffsets.push(at);
    const method = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    if (method !== 0) return null;
    if (view.getUint32(at + 22, true) !== size) return null; // uncompressed = stored
    const nameStart = at + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + size > bytes.length) return null;
    const path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const data = bytes.subarray(dataStart, dataStart + size);
    if (seen.has(path) || crc32(data) !== crc) return null;
    seen.add(path);
    parts.push({ path, bytes: data });
    at = dataStart + size;
  }
  if (parts.length === 0) return null;

  // Central directory: one header per walked entry, in order, pointing at the
  // local header walked with the same name, CRC-32 and sizes.
  const cdStart = at;
  let listed = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x02014b50) {
    if (at + 46 > bytes.length) return null;
    const part = parts[listed];
    if (!part) return null;
    const nameLen = view.getUint16(at + 28, true);
    if (at + 46 + nameLen > bytes.length) return null;
    if (view.getUint32(at + 42, true) !== localOffsets[listed]) return null;
    if (view.getUint32(at + 16, true) !== crc32(part.bytes)) return null;
    if (view.getUint32(at + 20, true) !== part.bytes.length || view.getUint32(at + 24, true) !== part.bytes.length) return null;
    if (decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)) !== part.path) return null;
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    listed++;
  }
  if (listed !== parts.length) return null;

  // End of central directory: points at the CD just validated, counts exactly
  // the entries walked, and is the last thing in the file (comment included).
  if (at + 22 > bytes.length || view.getUint32(at, true) !== 0x06054b50) return null;
  if (view.getUint32(at + 16, true) !== cdStart || view.getUint32(at + 12, true) !== at - cdStart) return null;
  if (view.getUint16(at + 8, true) !== parts.length || view.getUint16(at + 10, true) !== parts.length) return null;
  if (at + 22 + view.getUint16(at + 20, true) !== bytes.length) return null;
  return parts;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Full validation report — everything the page renders. */
export async function validatePackage(bytes) {
  const report = {
    readable: false,
    intact: false,
    formatVersion: null,
    manifest: null,
    parts: [], // {path, bytes, status: ok|modified|missing|unlisted}
    docProblems: [],
    doc: null,
    /** UI-only: why the container itself refused (never part of the vector
     *  verdict — the document layer does not run on an unreadable container). */
    containerProblem: null,
    unknownExtensions: [], // amber, non-fatal
    unknownTopLevel: [], // amber, non-fatal
  };
  const parts = unzipStore(bytes);
  if (!parts) {
    report.containerProblem =
      "Not a .designate package — the container must be a STORE-only zip whose central directory, CRC-32s and end record agree with its entries (compressed, duplicate, corrupted or trailing bytes are non-conforming).";
    return report;
  }
  const byPath = new Map(parts.map((p) => [p.path, p]));
  const manifestPart = byPath.get(MANIFEST_PATH);
  if (manifestPart) {
    try {
      const manifest = JSON.parse(new TextDecoder().decode(manifestPart.bytes));
      if (manifest && manifest.format === FORMAT_VERSION && Array.isArray(manifest.parts)) {
        report.readable = true;
        report.formatVersion = manifest.format;
        report.manifest = manifest;
        let intact = true;
        const listed = new Set();
        for (const entry of manifest.parts) {
          listed.add(entry.path);
          const got = byPath.get(entry.path);
          if (!got) {
            report.parts.push({ path: entry.path, bytes: 0, status: "missing" });
            intact = false;
          } else if ((await sha256Hex(got.bytes)) !== entry.sha256) {
            report.parts.push({ path: entry.path, bytes: got.bytes.length, status: "modified" });
            intact = false;
          } else {
            report.parts.push({ path: entry.path, bytes: got.bytes.length, status: "ok" });
          }
        }
        for (const p of parts) {
          if (p.path !== MANIFEST_PATH && !listed.has(p.path)) {
            report.parts.push({ path: p.path, bytes: p.bytes.length, status: "unlisted" });
            intact = false;
          }
        }
        report.intact = intact;
      }
    } catch {
      /* unreadable manifest → report stays unreadable */
    }
  }

  const KNOWN_TOP_LEVEL = new Set([
    "kind", "caseName", "matterNumber", "round", "transcripts", "designations",
    "filings", "recipes", "auditEvents", "verification", "extensions",
  ]);
  const roundPart = byPath.get("round.json");
  if (!roundPart) {
    report.docProblems.push("round.json missing");
    return report;
  }
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(roundPart.bytes));
  } catch {
    report.docProblems.push("round.json is not valid JSON");
    return report;
  }
  const problems = report.docProblems;
  if (doc.kind !== ROUND_DOCUMENT_KIND) problems.push(`kind must be "${ROUND_DOCUMENT_KIND}"`);
  if (!doc.round || typeof doc.round.id !== "string") problems.push("round section missing");
  if (!Array.isArray(doc.transcripts)) problems.push("transcripts section missing");
  if (!Array.isArray(doc.designations)) problems.push("designations section missing");
  if (!doc.verification || typeof doc.verification.spec !== "string")
    problems.push("verification section missing");
  if (doc.extensions != null && (typeof doc.extensions !== "object" || Array.isArray(doc.extensions)))
    problems.push("extensions must be an object");
  for (const seg of doc.designations ?? []) {
    if (typeof seg?.cite !== "string" || !seg.cite) {
      problems.push(`designation ${seg?.id ?? "?"} has no qualified cite`);
      break;
    }
  }
  if (problems.length === 0) {
    report.doc = doc;
    report.unknownExtensions = Object.keys(doc.extensions ?? {});
    report.unknownTopLevel = Object.keys(doc).filter((k) => !KNOWN_TOP_LEVEL.has(k));
  }
  return report;
}

/** The vector verdict shape shared by all three implementations. */
export async function verdict(bytes) {
  const r = await validatePackage(bytes);
  return { readable: r.readable, intact: r.intact, docProblems: r.docProblems };
}

/** Party-round rollup for the summary panel: designations grouped by party. */
export function partyRounds(doc) {
  const by = new Map();
  for (const d of doc?.designations ?? []) {
    const key = d.party ?? "other";
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([party, count]) => ({ party, count }));
}
