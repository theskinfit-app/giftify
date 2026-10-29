// app/models/gift-discounts.server.js
//
// ONE automatic app discount, backed by our Discount Function, covers every tier.
//
// Two earlier designs are dead ends, and both are worth knowing about:
//
//   1. One native Buy X Get Y discount per tier. A BXGY discount *consumes* the
//      cart items satisfying its "customer buys" condition, and separate BXGY
//      discounts compete for the same items — with three tiers the first two ate
//      the qualifying spend and the third's gift was never discounted. BXGY also
//      has no "any product" condition, which forced an auto-created "All products"
//      smart collection that overlapped the merchant's real ones.
//   2. A zero-priced gift variant and no discount at all. This shipped, and it works — but
//      only because it asks every merchant to create dedicated zero-priced products,
//      which are then purchasable by anyone who finds them on the storefront. It
//      existed solely because Shopify allows functions from a CUSTOM app only on
//      Shopify Plus stores.
//
// This app is publicly distributed, and "stores on any plan can use public apps
// that are distributed through the Shopify App Store and contain functions" — so the
// function is available to every merchant who installs it, on every plan, and the
// zero-price workaround is no longer needed.
// https://shopify.dev/docs/apps/build/functions
//
// The function evaluates all tiers itself, in one pass over one cart, so tiers stack
// cleanly: a 5,000 tier and a 10,000 tier both pay out on a 12,000 cart.
//
// Two copies of the tier config, for two different readers:
//   SHOP metafield (storefront PUBLIC_READ) -> the theme, which adds/removes the
//     gift line. Needs numeric ids, because it matches against /cart.js.
//   DISCOUNT metafield -> the function, which decides which gift lines are free.
//     Needs GIDs, because it matches against merchandise.product.id.
// upsertTier writes both, so they can't drift apart.

// Deliberately un-branded: this namespace shows up in every merchant's metafields,
// so it must not carry the name of the store this app was first built for.
export const SHOP_NS = "free_gift";
export const SHOP_KEY = "gift_tiers";

// Where we remember the single app discount we own.
const DISCOUNT_ID_KEY = "discount_node";

// Must match the `handle` in extensions/free-gift-discount/shopify.extension.toml.
const FUNCTION_HANDLE = "free-gift-discount";
const DISCOUNT_TITLE = "Free Gift";

// Matches the definition declared in shopify.app.*.toml as
//   [discount.metafields.app.function-configuration]
// `app` is how the reserved namespace is spelled in TOML; `$app` is how it is spelled
// in GraphQL, on both the read and the write side.
//
// There used to be a fallback here: try `$app`, and on any namespace error write to
// `app` instead. That fallback is why the function returned no discounts on live
// stores while everything else looked fine. `app` without the `$` is an ordinary
// merchant namespace, so the write "succeeded" into a place the function never reads,
// the save reported success, the tier list looked healthy, and every gift silently
// failed to be discounted.
//
// There is deliberately no fallback now. If this namespace is rejected the merchant
// gets an error, because a configuration nothing can read is worse than no save at
// all. writeDiscountConfig reads the value back to make sure of it.
const FN_CONFIG_KEY = "function-configuration";
// Must match `input_variables` in extensions/free-gift-discount/shopify.extension.toml.
const FN_VARIABLES_KEY = "function-variables";
const FN_CONFIG_NAMESPACE = "$app";

const numId = (gid) => (gid ? Number(String(gid).split("/").pop()) : null);

/**
 * An optional upper bound on a tier's threshold, so a tier can be a window
 * ("gift on orders of 6,000 to 7,999") instead of a floor. Blank, zero and anything
 * unparseable all mean no cap — tiers saved before this field existed must keep
 * behaving as open-ended.
 */
const capOrNull = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * How many items from the collection a `collection_contains` tier requires. Blank,
 * zero and anything unparseable mean 1 — which is how every tier saved before this
 * field existed behaved, since a cart line always carries at least one unit.
 */
const minQuantityOrOne = (raw) => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/**
 * True when a mutation failed because the discount is no longer there — the merchant
 * deleted it directly in the Shopify admin. Shopify reports this as "Automatic
 * discount does not exist."
 */
function isMissingDiscount(err) {
  const m = String(err?.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("not found");
}

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

// ---------------------------------------------------------------------------
// Shop-level config: the tier list the theme reads
// ---------------------------------------------------------------------------
async function readShopMetafield(admin, key) {
  const d = await gql(
    admin,
    `#graphql
    query ShopConfig($ns: String!, $key: String!) {
      shop { metafield(namespace: $ns, key: $key) { value } }
    }`,
    { ns: SHOP_NS, key },
  );
  return d?.shop?.metafield?.value ?? null;
}

export async function getTiers(admin) {
  try {
    const v = await readShopMetafield(admin, SHOP_KEY);
    return v ? JSON.parse(v) : [];
  } catch {
    return [];
  }
}

async function writeShopMetafield(admin, key, value, type = "json") {
  const { shop } = await gql(admin, `#graphql
    query { shop { id } }`);
  const d = await gql(
    admin,
    `#graphql
    mutation Save($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields: [{ ownerId: shop.id, namespace: SHOP_NS, key, type, value }] },
  );
  const errs = d.metafieldsSet.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
}

// Shopify caps a json metafield at 128KB. Stop well short of it: going over is not
// a clean failure, and the tier list has to survive one more tier being added.
const METAFIELD_LIMIT_BYTES = 128 * 1024;
const METAFIELD_SAFE_BYTES = Math.floor(METAFIELD_LIMIT_BYTES * 0.8);

/**
 * Refuse to save a tier list that will not fit, and say why.
 *
 * Collection tiers cache every product id in the collection for the theme script, so
 * enough collection tiers still blow the metafield limit. This is the only place that
 * ceiling still exists — the discount function stopped reading these lists and asks
 * Shopify for membership instead — but a merchant is owed a clear sentence about it
 * rather than a save that appears to work and a gift that never appears.
 */
function assertTiersFit(tiers, json) {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= METAFIELD_SAFE_BYTES) return;

  const biggest = tiers
    .filter((t) => (t.collectionProductIds?.length ?? 0) > 0)
    .sort((a, b) => b.collectionProductIds.length - a.collectionProductIds.length)[0];

  const which = biggest
    ? `"${biggest.name}" uses a collection with ${biggest.collectionProductIds.length.toLocaleString()} products. `
    : "";

  throw new Error(
    `This tier can't be saved: the configuration is ${Math.round(bytes / 1024)}KB and ` +
      `Shopify allows ${Math.round(METAFIELD_LIMIT_BYTES / 1024)}KB. ${which}` +
      "Across all collection tiers together, roughly 6,000 products fit. Use a " +
      "smaller collection, or delete a collection tier you no longer need.",
  );
}

async function persistTiers(admin, tiers) {
  const json = JSON.stringify(tiers);
  assertTiersFit(tiers, json);
  await writeShopMetafield(admin, SHOP_KEY, json);
}

/**
 * Ensure the shop metafield is defined with storefront read access so the theme can
 * read shop.metafields.free_gift.gift_tiers. Safe to call repeatedly.
 */
export async function ensureDefinition(admin) {
  await gql(
    admin,
    `#graphql
    mutation Def($def: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $def) {
        userErrors { code message }
      }
    }`,
    {
      def: {
        name: "Free Gift Tiers",
        namespace: SHOP_NS,
        key: SHOP_KEY,
        type: "json",
        ownerType: "SHOP",
        access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
      },
    },
  ).catch(() => {}); // ignore TAKEN
}

/** The shop's currency, so the admin UI can show amounts the merchant recognises. */
export async function getShopCurrency(admin) {
  try {
    const d = await gql(admin, `#graphql
      query { shop { currencyCode } }`);
    return d?.shop?.currencyCode ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * The collection's product ids, numeric, for the theme script.
 *
 * The function used to need these too, as GIDs, and that is what broke the app in
 * production: the configuration metafield grew with the collection, and a function's
 * input silently omits any metafield over 10,000 bytes. The function now asks Shopify
 * directly with `inCollections`, so it needs one collection id and nothing more. Only
 * the theme still needs a list, because a storefront has no equivalent API — all it
 * gets from /cart.js is a product id.
 *
 * Every exit from this function used to be silent. A collection that came back null,
 * one with more products than the paging loop covers, even an empty one — all of them
 * returned `[]`, the tier saved happily, and the storefront then measured every cart
 * as 0 against it. The tier simply never fired, with nothing anywhere to say why.
 * Each of those cases now throws something a merchant can act on.
 */
const COLLECTION_PAGES = 20;
const COLLECTION_PAGE_SIZE = 250;
const COLLECTION_CEILING = COLLECTION_PAGES * COLLECTION_PAGE_SIZE;

async function cacheCollectionProducts(admin, collectionGid) {
  const gids = [];
  let cursor = null;
  let more = false;

  for (let i = 0; i < COLLECTION_PAGES; i++) {
    const d = await gql(
      admin,
      `#graphql
      query Coll($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: collectionGid, cursor },
    );
    const conn = d?.collection?.products;
    if (!conn) {
      throw new Error(
        "That collection could not be read — it may have been deleted, or the app " +
          "may not have access to it. Pick the collection again and save.",
      );
    }
    conn.nodes.forEach((n) => gids.push(n.id));
    more = conn.pageInfo.hasNextPage;
    if (!more) break;
    cursor = conn.pageInfo.endCursor;
  }

  if (more) {
    // One collection of this size still fits the shop metafield comfortably; several
    // do not, which is the total that assertTiersFit polices. The two limits are
    // different questions, so they are allowed to quote different numbers.
    throw new Error(
      `That collection has more than ${COLLECTION_CEILING.toLocaleString()} products, ` +
        "which is more than the storefront script can carry. Use a smaller collection, " +
        "or split the tier across two collections.",
    );
  }

  if (!gids.length) {
    throw new Error(
      "That collection is empty, so the tier could never give anything away. " +
        "Add products to it, or pick a different collection.",
    );
  }

  return gids.map(numId);
}

/**
 * The variant to hand out as the gift.
 *
 * The merchant picks a PRODUCT, so we take its first variant. The gift is an ordinary
 * saleable product — the function is what makes the line free — so there is nothing
 * to prefer one variant over another by.
 */
async function giftDetails(admin, giftProductGid) {
  const d = await gql(
    admin,
    `#graphql
    query P($id: ID!) {
      product(id: $id) {
        title
        variants(first: 1) { nodes { id } }
      }
    }`,
    { id: giftProductGid },
  );
  const variantGid = d?.product?.variants?.nodes?.[0]?.id ?? null;
  return { title: d?.product?.title ?? "Gift", variantGid, variantId: numId(variantGid) };
}

// ---------------------------------------------------------------------------
// The single app discount
// ---------------------------------------------------------------------------
/**
 * Only what the function actually needs, and deliberately nothing that grows with
 * the merchant's catalogue.
 *
 * A metafield larger than 10,000 bytes is silently omitted from a Shopify Function's
 * input — no error, and the Admin API keeps returning it as if all were well. This
 * used to carry every product id in each tier's collection, so a collection of about
 * 500 products pushed the whole configuration past the limit and the function saw
 * null for ALL tiers. That is why gifts were added and immediately taken back out,
 * and why it came and went depending on which tiers were enabled.
 *
 * It now carries the COLLECTION id. The function asks Shopify whether a cart line is
 * in it, so this payload stays a few hundred bytes whatever the collection holds.
 */
function functionConfig(tiers) {
  return JSON.stringify({
    tiers: tiers
      .filter((t) => t.enabled !== false)
      .map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        threshold: t.threshold,
        thresholdMax: t.thresholdMax ?? null,
        minQuantity: t.minQuantity ?? 1,
        enabled: true,
        collectionGid: t.collectionGid ?? null,
      })),
  });
}

// `inCollections(ids:)` is fed from this metafield. Shopify rejects a list variable
// of more than 100 elements, which is one collection per tier.
const MAX_COLLECTION_VARIABLES = 100;

function functionVariables(tiers) {
  const collectionIds = [
    ...new Set(
      tiers.filter((t) => t.enabled !== false && t.collectionGid).map((t) => t.collectionGid),
    ),
  ];
  if (collectionIds.length > MAX_COLLECTION_VARIABLES) {
    throw new Error(
      `This app supports up to ${MAX_COLLECTION_VARIABLES} collection-based tiers at ` +
        `once, and there are now ${collectionIds.length}. Pause or delete a few.`,
    );
  }
  return JSON.stringify({ collectionIds });
}

/**
 * The discount itself. Deliberately carries NO metafields.
 *
 * Shopify's own tutorial sends the configuration inside this input, but it sends a
 * metafield `id` alongside namespace and key when UPDATING an existing discount. We
 * never had that id, so every update after the first silently failed to attach
 * anything — the mutation reported success and the function kept receiving null for
 * its configuration, on every store, forever. The gift was added, never discounted,
 * and pulled back out.
 *
 * writeDiscountConfig uses metafieldsSet instead, which upserts on
 * (owner, namespace, key) and needs no id, so create and update behave identically.
 */
function discountInput() {
  return {
    title: DISCOUNT_TITLE,
    functionHandle: FUNCTION_HANDLE,
    startsAt: new Date(0).toISOString(),
    discountClasses: ["PRODUCT"],
    // A gift must still be free when the customer is already using another
    // promotion, so opt into combining with every class.
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
  };
}

/**
 * Upsert both metafields the function reads: the tier configuration, and the
 * collection ids that feed $collectionIds into its input query.
 */
async function writeDiscountConfig(admin, discountId, tiers) {
  const d = await gql(
    admin,
    `#graphql
    mutation SetGiftConfig($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { namespace key }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: discountId,
          namespace: FN_CONFIG_NAMESPACE,
          key: FN_CONFIG_KEY,
          type: "json",
          value: functionConfig(tiers),
        },
        {
          ownerId: discountId,
          namespace: FN_CONFIG_NAMESPACE,
          key: FN_VARIABLES_KEY,
          type: "json",
          value: functionVariables(tiers),
        },
      ],
    },
  );
  const errs = d.metafieldsSet.userErrors;
  if (errs.length) {
    throw new Error(
      "The gift configuration could not be attached to the discount: " +
        errs.map((e) => e.message).join("; "),
    );
  }
}

/**
 * The function cannot see a metafield larger than this, and says nothing when that
 * happens. Checking here is the only way the merchant finds out before their
 * customers do.
 */
const FUNCTION_METAFIELD_LIMIT_BYTES = 10000;

/**
 * Refuse to write a configuration the function would not be able to read.
 *
 * Shopify omits a metafield over 10,000 bytes from a function's input, silently and
 * with no error anywhere: the Admin API keeps returning it, the discount keeps
 * looking healthy, and the function just sees null for its whole configuration and
 * discounts nothing. That is what took the live app down, so this is a hard stop,
 * not a warning.
 *
 * Since the collection product lists left the configuration, the only thing that
 * grows here is the number of tiers and the length of their names — a few hundred
 * bytes each, so a merchant has to be well into the dozens before this fires.
 */
function assertConfigFitsFunctionInput(tiers) {
  const json = functionConfig(tiers);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= FUNCTION_METAFIELD_LIMIT_BYTES * 0.8) return;
  const active = tiers.filter((t) => t.enabled !== false).length;
  throw new Error(
    `The gift configuration is ${bytes} bytes and a Shopify Function cannot read ` +
      `more than ${FUNCTION_METAFIELD_LIMIT_BYTES}. There are ${active} active tiers; ` +
      "pause or delete a few, or shorten their names.",
  );
}

async function createDiscount(admin) {
  const d = await gql(
    admin,
    `#graphql
    mutation CreateGiftDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount { discountId }
        userErrors { field message }
      }
    }`,
    { automaticAppDiscount: discountInput() },
  );
  const errs = d.discountAutomaticAppCreate.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  const id = d.discountAutomaticAppCreate.automaticAppDiscount.discountId;
  await writeShopMetafield(admin, DISCOUNT_ID_KEY, id, "single_line_text_field");
  return id;
}

async function updateDiscount(admin, id) {
  const d = await gql(
    admin,
    `#graphql
    mutation UpdateGiftDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
        userErrors { field message }
      }
    }`,
    { id, automaticAppDiscount: discountInput() },
  );
  const errs = d.discountAutomaticAppUpdate.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
}

/**
 * Read the configuration straight back off the discount.
 *
 * The mutation reporting no userErrors is not proof the function can see anything:
 * that is exactly how the namespace bug hid for so long. Reading it back is the only
 * check that matches what the function itself does at runtime.
 */
async function discountConfigIsReadable(admin, discountId) {
  try {
    const d = await gql(
      admin,
      `#graphql
      query GiftConfigCheck($id: ID!, $ns: String!, $key: String!) {
        node(id: $id) {
          ... on DiscountAutomaticNode {
            metafield(namespace: $ns, key: $key) { value }
          }
        }
      }`,
      { id: discountId, ns: FN_CONFIG_NAMESPACE, key: FN_CONFIG_KEY },
    );
    return Boolean(d?.node?.metafield?.value);
  } catch {
    // Fail OPEN on a lookup failure: refusing the save because we could not verify
    // would block a merchant over a transient read.
    return true;
  }
}

/**
 * Push the current tier list into the function's configuration, creating the discount
 * on first use. Self-heals if the merchant deleted it in the admin.
 */
async function syncDiscount(admin, tiers) {
  const storedId = await readShopMetafield(admin, DISCOUNT_ID_KEY);
  let id = storedId;

  if (!id) {
    id = await createDiscount(admin);
  } else {
    try {
      await updateDiscount(admin, id);
    } catch (e) {
      if (!isMissingDiscount(e)) throw e;
      id = await createDiscount(admin);
    }
  }

  // Always after the discount exists, and always separately from it. This is the
  // step that was quietly doing nothing.
  assertConfigFitsFunctionInput(tiers);
  await writeDiscountConfig(admin, id, tiers);

  if (!(await discountConfigIsReadable(admin, id))) {
    throw new Error(
      "The gift configuration was saved but the discount function cannot read it " +
        `(namespace "${FN_CONFIG_NAMESPACE}", key "${FN_CONFIG_KEY}"). No gift would ` +
        "be made free, so the tier was not saved. Please report this.",
    );
  }
  return id;
}

/**
 * Delete the leftover per-tier BXGY discounts from the oldest design. Called on save,
 * so the first save after upgrading cleans up automatically instead of leaving stale
 * discounts fighting the function for the same cart items.
 */
async function removeLegacyBxgyDiscounts(admin, tiers) {
  for (const id of tiers.map((t) => t.discountNodeId).filter(Boolean)) {
    await gql(
      admin,
      `#graphql
      mutation DelLegacy($id: ID!) {
        discountAutomaticDelete(id: $id) { userErrors { field message } }
      }`,
      { id },
    ).catch(() => {}); // already gone, or not ours any more — either way, move on
  }
}

// ---------------------------------------------------------------------------
// Create / update a tier
// ---------------------------------------------------------------------------
export async function upsertTier(admin, form) {
  await ensureDefinition(admin);
  const tiers = await getTiers(admin);
  const existing = form.id ? tiers.find((t) => t.id === form.id) : null;

  const tier = {
    id: form.id || `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: form.name?.trim() || "Free gift tier",
    type: form.type,
    threshold: form.type === "collection_contains" ? 0 : Number(form.threshold) || 0,
    thresholdMax: form.type === "collection_contains" ? null : capOrNull(form.thresholdMax),
    // Only meaningful for collection_contains; the subtotal tiers measure money.
    minQuantity: form.type === "collection_contains" ? minQuantityOrOne(form.minQuantity) : 1,
    collectionGid: form.collectionGid || null,
    collectionId: numId(form.collectionGid),
    // Numeric ids, for the theme script only. The function resolves membership
    // through `inCollections` and never reads this.
    collectionProductIds: [],
    giftProductGid: form.giftProductGid,
    giftProductId: numId(form.giftProductGid),
    giftVariantGid: null,
    giftVariantId: null,
    giftProductTitle: "",
    enabled: form.enabled !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (tier.type !== "order_subtotal" && tier.collectionGid) {
    tier.collectionProductIds = await cacheCollectionProducts(admin, tier.collectionGid);
  }
  const gift = await giftDetails(admin, tier.giftProductGid);
  tier.giftProductTitle = gift.title;
  tier.giftVariantGid = gift.variantGid;
  tier.giftVariantId = gift.variantId;

  const idx = tiers.findIndex((t) => t.id === tier.id);
  if (idx >= 0) tiers[idx] = tier;
  else tiers.push(tier);

  // Check the size BEFORE writing anything. syncDiscount runs first and would
  // otherwise fail with a raw Shopify error after the discount had already been
  // touched, leaving the store half-updated.
  assertTiersFit(tiers, JSON.stringify(tiers));

  await removeLegacyBxgyDiscounts(admin, tiers);
  // The function is the source of truth for what is free, so it has to know about
  // the tier before the theme starts handing its gift out.
  await syncDiscount(admin, tiers);

  // Strip fields earlier designs left behind, for every tier and not just the one
  // being saved. collectionProductGids is the expensive one: it doubled the size of
  // a collection tier and nothing reads it any more, so one save of any tier shrinks
  // the whole metafield. The numeric ids it duplicated stay, and the discount
  // function's legacy path reads those, so an old tier keeps working untouched.
  await persistTiers(
    admin,
    tiers.map((t) => {
      const copy = { ...t };
      delete copy.discountNodeId;
      delete copy.giftVariantPrice; // left over from the zero-priced variant design
      delete copy.collectionProductGids;
      return copy;
    }),
  );
  return tier;
}

// ---------------------------------------------------------------------------
// Pause / resume and delete — all just reshape the one discount's config
// ---------------------------------------------------------------------------
export async function setTierEnabled(admin, id, enabled) {
  const tiers = await getTiers(admin);
  const tier = tiers.find((t) => t.id === id);
  if (!tier) return;

  tier.enabled = enabled;
  tier.updatedAt = new Date().toISOString();
  await syncDiscount(admin, tiers);
  await persistTiers(admin, tiers);
}

export async function deleteTier(admin, id) {
  const tiers = await getTiers(admin);
  const tier = tiers.find((t) => t.id === id);
  const remaining = tiers.filter((t) => t.id !== id);

  // Clean up the tier's own legacy BXGY discount, if it still has one.
  if (tier?.discountNodeId) await removeLegacyBxgyDiscounts(admin, [tier]);

  await syncDiscount(admin, remaining);
  await persistTiers(admin, remaining);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
/**
 * Tiers annotated with the state of the one discount that backs them all. If it is
 * missing or inactive, no gift can be made free, and the merchant needs to know
 * before customers start seeing gifts they'd be charged for.
 */
export async function getTiersWithHealth(admin) {
  const tiers = await getTiers(admin);
  if (!tiers.length) return [];

  let status = null;
  let checked = false;
  try {
    const storedId = await readShopMetafield(admin, DISCOUNT_ID_KEY);
    if (storedId) {
      const d = await gql(
        admin,
        `#graphql
        query GiftDiscountHealth($id: ID!) {
          node(id: $id) {
            ... on DiscountAutomaticNode {
              automaticDiscount {
                __typename
                ... on DiscountAutomaticApp { status }
              }
            }
          }
        }`,
        { id: storedId },
      );
      status = d?.node?.automaticDiscount?.status ?? null;
    }
    checked = true;
  } catch {
    // Fail OPEN: reporting a healthy tier as broken switches off a working promotion,
    // which is worse than being slow to notice a broken one. The storefront's own
    // "a gift must be free" check is the real safety net.
    checked = false;
  }

  // A tier is only broken if we actually established that the discount is gone or
  // not running.
  const broken = checked && status !== "ACTIVE";
  return tiers.map((t) => ({
    ...t,
    discountStatus: status,
    broken: broken && t.enabled !== false,
  }));
}
