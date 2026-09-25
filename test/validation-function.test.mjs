// Tests for extensions/free-gift-validation/src/cart_validations_generate_run.js
//
// The extension's own vitest suite compiles to Wasm and needs schema.graphql, which
// the Shopify CLI only fetches once the app is linked. This runs the same function as
// plain JavaScript against the same fixtures, so the logic is verifiable before any
// of that — and it covers two things a fixture cannot express: a missing cart, and a
// missing input object.
//
// Run with: npm run test:validation

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cartValidationsGenerateRun } from "../extensions/free-gift-validation/src/cart_validations_generate_run.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "extensions", "free-gift-validation", "tests", "fixtures");

let failures = 0;
let checks = 0;

function check(ok, label, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail) console.log(`        ${detail}`);
}

console.log("\ncartValidationsGenerateRun(): one free gift per order");

for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort()) {
  const { payload } = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
  const got = cartValidationsGenerateRun(payload.input);
  const ok = JSON.stringify(got) === JSON.stringify(payload.output);
  const errors = got.operations.flatMap((o) => o.validationAdd?.errors ?? []).length;
  check(
    ok,
    `${file} -> ${errors ? "checkout blocked" : "checkout allowed"}`,
    `got      ${JSON.stringify(got)}\n        expected ${JSON.stringify(payload.output)}`,
  );
}

// A validation function that throws blocks every checkout on the store, so the
// defensive reads in the function matter more than they look.
for (const [label, input] of [
  ["empty cart", { cart: { lines: [] } }],
  ["no cart key", {}],
  ["undefined input", undefined],
]) {
  let got;
  try {
    got = JSON.stringify(cartValidationsGenerateRun(input));
  } catch (e) {
    check(false, `${label} must not throw`, e.message);
    continue;
  }
  check(got === '{"operations":[]}', `${label} -> ${got}`, 'expected {"operations":[]}');
}

console.log(
  `\n${checks - failures}/${checks} checks passed` + (failures ? ` — ${failures} FAILED` : ""),
);
process.exit(failures ? 1 : 0);
