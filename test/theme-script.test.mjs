// Tests for extensions/free-gift-theme/assets/free-gift.js
//
// That file is an IIFE with no exports — it has to be, because it ships straight to
// merchant storefronts with no build step. So rather than restructure shipping code
// to make it testable, each suite below lifts the REAL function source out of the
// file and runs it with stubs. If someone edits the function, these tests see the
// edit; they cannot drift into testing a stale copy.
//
// Run with: npm run test:theme   (plain node, no test runner, no dependencies)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(HERE, "..", "extensions", "free-gift-theme", "assets", "free-gift.js"),
  "utf8",
);

let failures = 0;
let checks = 0;

function suite(name) {
  console.log(`\n${name}`);
}
function check(ok, label, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && detail) console.log(`        ${detail}`);
}

/** Lift a top-level function out of the source by name. */
function lift(name, arity) {
  const re = new RegExp(`function ${name}\\(${arity}\\) \\{[\\s\\S]*?\\n  \\}`);
  const m = SRC.match(re);
  if (!m) {
    console.error(`could not locate ${name}() in free-gift.js — did it get renamed?`);
    process.exit(2);
  }
  return m[0];
}

// ---------------------------------------------------------------------------
// qualifies() — thresholds, and the optional upper bound that makes a tier a window
// ---------------------------------------------------------------------------
suite("qualifies(): threshold floor, optional cap, collection item count");
{
  let measured = 0;
  // qualifies() leans on minQuantity(), so lift the real one rather than stub it —
  // the two are a pair and a stub would hide a change to either.
  const qualifies = new Function(
    "measure",
    lift("minQuantity", "tier") + "\nreturn " + lift("qualifies", "tier, cart"),
  )(() => measured);

  const cases = [
    [{ type: "order_subtotal", threshold: 6000, thresholdMax: 7999 }, 5999, false, "below the floor"],
    [{ type: "order_subtotal", threshold: 6000, thresholdMax: 7999 }, 6000, true, "exactly on the floor"],
    [{ type: "order_subtotal", threshold: 6000, thresholdMax: 7999 }, 7999, true, "exactly on the cap"],
    [{ type: "order_subtotal", threshold: 6000, thresholdMax: 7999 }, 8000, false, "one past the cap"],
    // Every shape a stored tier can take for "no cap" must stay open-ended.
    [{ type: "order_subtotal", threshold: 6000 }, 99999, true, "cap absent"],
    [{ type: "order_subtotal", threshold: 6000, thresholdMax: null }, 99999, true, "cap null"],
    [{ type: "order_subtotal", threshold: 6000, thresholdMax: 0 }, 99999, true, "cap zero"],
    [{ type: "order_subtotal", threshold: 6000, thresholdMax: "" }, 99999, true, "cap blank"],
    // collection_contains counts items. No minQuantity means 1, which is how every
    // tier saved before that field existed behaved.
    [{ type: "collection_contains" }, 0, false, "contains: no items, no minQuantity"],
    [{ type: "collection_contains" }, 1, true, "contains: one item, no minQuantity"],
    [{ type: "collection_contains", minQuantity: 2 }, 1, false, "contains: 1 item, needs 2"],
    [{ type: "collection_contains", minQuantity: 2 }, 2, true, "contains: 2 items, needs 2"],
    [{ type: "collection_contains", minQuantity: 2 }, 5, true, "contains: 5 items, needs 2"],
    [{ type: "collection_contains", minQuantity: 0 }, 1, true, "contains: minQuantity 0 means 1"],
    [{ type: "collection_contains", minQuantity: null }, 1, true, "contains: minQuantity null means 1"],
    [{ type: "collection_subtotal", threshold: 5000, thresholdMax: 9000 }, 9000, true, "collection cap inclusive"],
    [{ type: "collection_subtotal", threshold: 5000, thresholdMax: 9000 }, 9500, false, "collection past cap"],
  ];

  for (const [tier, value, expected, label] of cases) {
    measured = value;
    const got = qualifies(tier, {});
    check(got === expected, `${label} (value=${value}) -> ${got}`, `expected ${expected}`);
  }
}

// ---------------------------------------------------------------------------
// money() — minor units AND presentment currency, both converted to shop currency
// ---------------------------------------------------------------------------
suite("money(): converts minor units and presentment currency to shop currency");
{
  // presentmentRate() reads window.Shopify.currency.rate, so both globals are
  // injected. A wrong-direction conversion (multiply instead of divide) fails the
  // PKR case below, which is the point of testing with a real-world rate.
  const withRate = (rate) => {
    const win = rate === undefined ? {} : { Shopify: { currency: { rate } } };
    return new Function(
      "window",
      "Shopify",
      lift("presentmentRate", "") + "\nreturn " + lift("money", "cents"),
    )(win, win.Shopify);
  };

  const cases = [
    [undefined, 1000, 10, "no Shopify global at all"],
    [1, 1000, 10, "rate 1 (single-currency store)"],
    ["1.0", 1000, 10, "rate as a string, as Shopify publishes it"],
    // Shop in PKR, customer browsing in USD. A 10,000 PKR cart shows as $36.
    [0.0036, 3600, 10000, "PKR shop, USD visitor — converts back to shop currency"],
    [0, 1000, 10, "rate 0 falls back to 1 rather than dividing by zero"],
    ["abc", 1000, 10, "unparseable rate falls back to 1"],
    [-2, 1000, 10, "negative rate falls back to 1"],
  ];

  for (const [rate, cents, expected, label] of cases) {
    const got = withRate(rate)(cents);
    check(got === expected, `${label} -> ${got}`, `expected ${expected}`);
  }
}

// ---------------------------------------------------------------------------
// measure() — collection_contains counts units, not lines
// ---------------------------------------------------------------------------
suite("measure(): collection_contains counts units, not lines");
{
  const stubs = {
    realLines: (cart) => cart.items,
    money: (cents) => cents / 100,
    lineValue: (l) => l.final_line_price,
  };
  const measure = new Function(
    ...Object.keys(stubs),
    "return " + lift("measure", "tier, cart"),
  )(...Object.values(stubs));

  const tier = { type: "collection_contains", collectionProductIds: [1, 2] };
  const cart = (items) => ({ items });

  const cases = [
    [[{ product_id: 1, quantity: 5 }], 5, "5 of one collection product counts as 5"],
    [
      [{ product_id: 1, quantity: 2 }, { product_id: 2, quantity: 3 }],
      5,
      "2 + 3 across two lines counts as 5",
    ],
    [[{ product_id: 9, quantity: 7 }], 0, "products outside the collection don't count"],
    [
      [{ product_id: 1, quantity: 1 }, { product_id: 9, quantity: 9 }],
      1,
      "only the collection line is counted",
    ],
    [[], 0, "empty cart"],
  ];

  for (const [items, expected, label] of cases) {
    const got = measure(tier, cart(items));
    check(got === expected, `${label} -> ${got}`, `expected ${expected}`);
  }
}

// ---------------------------------------------------------------------------
// fixGiftQuantities() — a gift line is always quantity 1
// ---------------------------------------------------------------------------
suite("fixGiftQuantities(): restores the one-per-gift invariant");
{
  let posted = null;
  const stubs = {
    isGift: (l) => !!(l.properties && l.properties._gift),
    post: (p, body) => { posted = { path: p, body }; return Promise.resolve({ ok: true, body: null }); },
    isFullCart: () => false,
    readCart: () => Promise.resolve({ items: [], item_count: 0 }),
    debug: () => {},
  };
  const fixGiftQuantities = new Function(
    ...Object.keys(stubs),
    "return " + lift("fixGiftQuantities", "cart"),
  )(...Object.values(stubs));

  const gift = (key, qty) => ({ key, quantity: qty, properties: { _gift: "t1" } });
  const own = (key, qty) => ({ key, quantity: qty, properties: {} });

  const cases = [
    ["already correct", [own("a", 7), gift("g1", 1)], null],
    ["gift inflated to 7", [own("a", 7), gift("g1", 7)], { g1: 1 }],
    ["two gifts, one inflated", [gift("g1", 1), gift("g2", 3)], { g2: 1 }],
    ["both gifts inflated", [gift("g1", 5), gift("g2", 3)], { g1: 1, g2: 1 }],
    // The important one: a shopper buying 7 of something is untouched.
    ["customer line at 7 untouched", [own("a", 7), own("b", 12)], null],
    ["empty cart", [], null],
  ];

  for (const [label, items, expected] of cases) {
    posted = null;
    const r = await fixGiftQuantities({ items });
    const updates = posted ? posted.body.updates : null;
    const ok = JSON.stringify(updates) === JSON.stringify(expected) && r.fixed === !!expected;
    check(ok, `${label} -> ${JSON.stringify(updates)}`, `expected ${JSON.stringify(expected)}`);
  }
}

// ---------------------------------------------------------------------------
// clampCartWriteBody() — hold a gift at 1 in any cart write, in any body shape
// ---------------------------------------------------------------------------
suite("clampCartWriteBody(): clamps gift writes, never the customer's own");
{
  const parts = [
    "var GIFT_MAX = 1;",
    lift("clampJsonBody", "o"),
    lift("clampParams", "p"),
    lift("clampCartWriteBody", "body"),
  ].join("\n");
  const build = new Function(
    "giftKeys",
    "giftPositions",
    "cartLineCount",
    "debug",
    parts + "\nreturn clampCartWriteBody;",
  );
  // Cart shape under test: [1]=gift, [2]=product, [3]=gift, [4]=product
  const clamp = (lineCount) =>
    build({ GIFTA: true, GIFTB: true }, { 1: true, 3: true }, lineCount, () => {});

  const cases = [
    ['{"id":"GIFTA","quantity":5}', '{"id":"GIFTA","quantity":1}', "JSON change by gift key"],
    ['{"id":"PROD1","quantity":5}', '{"id":"PROD1","quantity":5}', "JSON change by CUSTOMER key"],
    ['{"line":3,"quantity":6}', '{"line":3,"quantity":1}', "JSON change by gift index"],
    ['{"line":2,"quantity":6}', '{"line":2,"quantity":6}', "JSON change by CUSTOMER index"],
    ['{"updates":{"GIFTA":5,"PROD1":5}}', '{"updates":{"GIFTA":1,"PROD1":5}}', "keyed updates"],
    ['{"updates":[5,5,6,6]}', '{"updates":[1,5,1,6]}', "positional updates, count matches"],
    // Stale picture: refuse to touch anything rather than rewrite the wrong line.
    ['{"updates":[5,5]}', '{"updates":[5,5]}', "positional updates, count MISMATCH"],
    ["id=GIFTB&quantity=7", "id=GIFTB&quantity=1", "urlencoded change by gift key"],
    ["id=PROD1&quantity=7", "id=PROD1&quantity=7", "urlencoded change by CUSTOMER key"],
    [
      "updates[GIFTA]=5&updates[PROD1]=6",
      "updates%5BGIFTA%5D=1&updates%5BPROD1%5D=6",
      "urlencoded keyed updates",
    ],
    [
      "updates[]=5&updates[]=5&updates[]=6&updates[]=6",
      "updates%5B%5D=1&updates%5B%5D=5&updates%5B%5D=1&updates%5B%5D=6",
      "urlencoded positional updates",
    ],
    ["hello=world", "hello=world", "unrelated body untouched"],
    ["{not json", "{not json", "malformed JSON untouched"],
  ];

  for (const [input, expected, label] of cases) {
    const got = clamp(4)(input);
    check(got === expected, `${label}`, `got ${got}\n        expected ${expected}`);
  }

  const fd = new FormData();
  fd.append("updates[GIFTA]", "5");
  fd.append("updates[PROD1]", "5");
  clamp(4)(fd);
  check(
    fd.get("updates[GIFTA]") === "1" && fd.get("updates[PROD1]") === "5",
    "FormData: gift clamped, customer untouched",
  );
}

console.log(
  `\n${checks - failures}/${checks} checks passed` + (failures ? ` — ${failures} FAILED` : ""),
);
process.exit(failures ? 1 : 0);
