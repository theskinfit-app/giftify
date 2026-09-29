# Giftify: Tiered Free Gifts

A Shopify app that gives customers a free gift when their cart meets a condition the
merchant sets. Tiers stack, so a 5,000 tier and a 10,000 tier both pay out on a 12,000
cart.

Three kinds of condition:

| Condition | Measured on |
|---|---|
| `order_subtotal` | The whole cart, in the shop's currency |
| `collection_subtotal` | Only items from one collection |
| `collection_contains` | The **number of items** from one collection |

Subtotal tiers can also take an upper bound, so a tier can be a window — "a gift on
orders between 6,000 and 7,999" — rather than a floor.

---

## The one thing to understand first

**A gift is an ordinary product that the app's discount function makes free.**

The theme app embed decides *which* gift belongs in the cart and adds or removes the
line. A Shopify Function decides *which* gift lines are free. Both read the same tier
configuration, so they cannot disagree.

Two earlier designs are dead ends. Both are documented at the top of
[`app/models/gift-discounts.server.js`](app/models/gift-discounts.server.js), and
neither should be reintroduced as a "simplification":

1. **One native Buy X Get Y discount per tier.** A BXGY discount *consumes* the cart
   items that satisfy its condition, so separate tiers competed for the same spend —
   with three tiers, the third one's gift was never discounted.
2. **A zero-priced gift variant and no discount at all.** It works, but it asks every
   merchant to create dedicated 0-priced products, which anyone who finds them can buy
   for nothing. It only existed because Shopify allows Functions from a *custom* app
   solely on Shopify Plus stores. Public App Store apps have no such restriction, which
   is what made the function approach possible here.

### The safety net

`dropPayableGifts` in the theme script removes any `_gift` line whose
`final_line_price > 0`. It never assumes the discount worked — if the merchant paused
it, or another promotion won the line, the gift comes back out rather than the customer
being charged for it. Do not remove this.

---

## Architecture

```
app/                                   Embedded admin app (React Router 7, SSR)
  models/gift-discounts.server.js      ALL tier logic — read this before changing anything
  routes/
    app._index.jsx                     Tier list: health banner, pause/resume/delete
    app.gifts.$id.jsx                  Tier editor
    app.support.jsx                    Merchant-facing help
    webhooks.compliance.jsx            GDPR topics, required for App Store review
extensions/
  free-gift-theme/                     Theme app embed — runs on every storefront
    blocks/free-gift.liquid            Injects the tier config and the toast markup
    assets/free-gift.js                Adds/removes gifts, reconciles, guards quantity
  free-gift-discount/                  Discount Function — makes gift lines free
  free-gift-validation/                Validation Function — blocks checkout on gift qty > 1
test/                                  Dependency-free node tests for the above
prisma/schema.prisma                   Shopify sessions only
```

### Where state lives

**Tier configuration is a shop metafield, not a database row** — namespace `free_gift`,
key `gift_tiers`, with `storefront: PUBLIC_READ` so the Liquid block can read it
directly. Postgres stores nothing but Shopify sessions, which means the database is
disposable: losing it costs a re-authentication and nothing else.

```
Admin UI  →  metafieldsSet(free_gift.gift_tiers)  →  Liquid block reads it
          →  window.__FREE_GIFT_TIERS__  →  free-gift.js decides and mutates the cart
```

Gift cart lines carry the line property `_gift`, whose value is the tier id. That
property is the join key across the theme script, both functions and the quantity
guard. **Never rename it.**

---

## Setup

Requires Node 20.19+ (or 22.12+) and the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started).

```bash
npm install
npm run dev          # shopify app dev
```

Local development runs on SQLite; production runs on Postgres. The SQLite schema is
generated from `prisma/schema.prisma` by `scripts/dev-schema.mjs` on every dev run, so
there is only ever one source of truth. `.env` needs a single line:

```
DATABASE_URL="file:./dev.sqlite"
```

Production needs `DATABASE_URL` (Postgres), `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
`SHOPIFY_APP_URL` and `SCOPES`.

### Commands

```bash
npm run build            # react-router build
npm run lint
npm run deploy           # shopify app deploy — pushes extensions + config

npm run test:theme       # theme script: thresholds, gift-quantity invariant, write guard
npm run test:validation  # validation function logic and its fixtures
```

Both test scripts are plain node — no runner, no dependencies. They lift the **real
function source** out of the shipped files and run it against stubs, so they cannot
drift into testing a stale copy.

The two function extensions have their own fixture suites, which compile to Wasm first:

```bash
cd extensions/free-gift-discount && npm test
cd extensions/free-gift-validation && npm test
```

### Debugging a storefront

```js
localStorage.setItem('free_gift_debug', '1')   // then reload for verbose logs
__freeGiftInspect()                            // per-line and per-tier decision dump
__freeGiftReset()                              // clear blocked tiers and the mutation budget
```

If no gift ever appears, check the theme app embed is switched on first —
**Online Store → Themes → Customize → App embeds → Free Gift**. It is off by default
and is by far the most common cause.

---

## Things that will bite you

**`automatically_update_urls_on_dev = false` is load-bearing.** `application_url` points
at production, and `shopify app dev` would otherwise overwrite it with a temporary
tunnel and take the live app down.

**`shopify app config use` decides which app you deploy to.** Run `shopify app info`
before any deploy.

**The `[events]` block in the app config is a required no-op.** Shopify CLI 4.7.0 fails
`deploy` and `dev` with `[events]: Required` without it, and its `api_version` must be
`"unstable"` — do not "fix" it to match `[webhooks].api_version`.

**The function test suites need a long hook timeout.** Compiling to Wasm takes minutes.
The scaffold's 45-second `beforeAll` timeout made every test report as *skipped*, which
reads exactly like success — the suite had never once run.

**Money is normalised from presentment to shop currency in two places, and they must
agree.** Cart amounts arrive in the customer's currency; thresholds are typed in the
shop's. The theme divides by `Shopify.currency.rate`; the discount function divides by
`input.presentmentCurrencyRate`. On a single-currency store both are 1, so a regression
here stays invisible until a Shopify Markets merchant installs the app.

**The admin UI uses Polaris web components** (`<s-page>`, `<s-banner>`…), not
`@shopify/polaris`. Do not add React Polaris imports.

**The discount function targets `cart.lines.discounts.generate.run` only.** The
scaffold's delivery-options target was removed deliberately — declaring it gives the
discount the SHIPPING class, and this app has no business touching shipping.

### Working on `extensions/free-gift-theme/assets/free-gift.js`

This ships to unknown merchant themes, so the constraints are unusual. The file is
commented with the *reason* behind each choice; read the comment before changing the
code under it.

- **ES5 on purpose** (`var`, `function`, IIFE) — broad storefront support, no build step.
- **Never touch theme-specific DOM.** Write through `Shopify.actions.updateCart`, detect
  through `shopify:cart:lines-update` (with fetch/XHR interception as a fallback), read
  through `/cart.js`, and refresh through the theme's own event protocols.
- **`origFetch` discipline.** The script patches `window.fetch`; its own calls must use
  the captured original or every gift mutation re-triggers reconciliation.
- **Thresholds are measured on the customer's own lines only.** Counting gift lines
  creates a feedback loop where a gift pushes the cart over or under its own threshold.
- **The interceptor is a pure observer with one exception:** it clamps gift line
  quantities down to 1 in flight, and a capture-phase `submit` listener does the same to
  the cart form's `updates` inputs. Index-based updates are clamped only when the body's
  line count matches the last-read cart — a stale picture must never rewrite the wrong
  line. The checkout button is never blocked.

## Licence

UNLICENSED. All rights reserved.
