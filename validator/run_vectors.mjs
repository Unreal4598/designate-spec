// CI vector runner for the JS validator core — the third implementation,
// pinned to the same published vectors as the app and the Python reference.
//   node validator/run_vectors.mjs vectors
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { verdict } from "./v1/designate-core.mjs";

const dir = process.argv[2] ?? "vectors";
const dirs = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
let failures = 0;
for (const name of dirs) {
  const pkg = new Uint8Array(readFileSync(path.join(dir, name, "package.designate")));
  const expected = JSON.parse(readFileSync(path.join(dir, name, "expected.json"), "utf8"));
  const got = await verdict(pkg);
  const want = {
    readable: expected.readable,
    intact: expected.intact,
    docProblems: expected.docProblems,
  };
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    console.log(`      want ${JSON.stringify(want)}`);
    console.log(`      got  ${JSON.stringify(got)}`);
  }
}
console.log(`\n${dirs.length - failures}/${dirs.length} vectors pass`);
process.exit(failures === 0 ? 0 : 1);
