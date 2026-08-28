// Validator core for `.designate` v1 — runs unchanged in the browser (the
// verify.designate.legal page) and in Node (the CI vector runner). No
// dependencies; WebCrypto for digests. This is the third independent
// implementation of the format (app TypeScript, reference Python, this) —
// all three are pinned to the same published test vectors.

export const FORMAT_VERSION = "designate/1";
export const ROUND_DOCUMENT_KIND = "designate/1 round";
const MANIFEST_PATH = "manifest.json";

/** STORE-only zip reader: local file headers walked front to back.
 *  Compressed entries are refused — the container is meant to be auditable. */
export function unzipStore(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const parts = [];
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    if (at + 30 > bytes.length) return null;
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    if (method !== 0) return null;
    const nameStart = at + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + size > bytes.length) return null;
    parts.push({
      path: decoder.decode(bytes.subarray(nameStart, nameStart + nameLen)),
      bytes: bytes.subarray(dataStart, dataStart + size),
    });
    at = dataStart + size;
  }
  return parts.length > 0 ? parts : null;
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
      "Not a .designate package — the container must be a STORE-only zip (compressed entries are non-conforming).";
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
