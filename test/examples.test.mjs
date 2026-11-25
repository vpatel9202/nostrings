// examples/*.js are saved scripts that ship with nostrings: each one starts
// with a `// ` description line and has a row in the table in examples/README.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

test("examples: every script has a description and a README row", () => {
  const scripts = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  const rows = new Set([...readme.matchAll(/^\|\s*\[[^\]]*\]\(([^)]+\.js)\)/gm)].map((m) => m[1]));
  const problems = [];
  for (const file of scripts) {
    const first = fs.readFileSync(path.join(dir, file), "utf8").split("\n", 1)[0];
    if (!/^\/\/ \S/.test(first)) problems.push(`${file}: first line is not a "// " description`);
    if (!rows.has(file)) problems.push(`${file}: no row in examples/README.md`);
  }
  for (const file of rows) {
    if (!scripts.includes(file)) problems.push(`${file}: linked in examples/README.md but missing from examples/`);
  }
  assert.deepEqual(problems, []);
});
