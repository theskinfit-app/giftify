import { DiscountClass, ProductDiscountSelectionStrategy } from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

const NO_DISCOUNTS = { operations: [] };

/**
 * Free Gift — makes the gift lines free, one function for every tier.
 *
 * This replaces one automatic Buy X Get Y discount per tier. A BXGY discount
 * *consumes* the cart items that satisfy its "customer buys" condition, and
 * separate BXGY discounts compete for the same items: with three tiers the first
 * two ate the qualifying spend and the third had nothing left, so its gift was
 * never discounted and the storefront had to pull it back out. Judging every
 * tier here, in one pass over one cart, removes that competition completely.
 *
 * It also closes a hole the BXGY setup had. A line is only discounted if it
 * carries the `_gift` attribute we set when granting it AND its tier's condition
 * genuinely holds. A customer who adds a gift SKU to their cart by hand pays for it.
 *
 * The theme script decides which gifts go in the cart; this decides which of them
 * are free. Both read the same tier config, so they can't disagree.
 *
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) return NO_DISCOUNTS;
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) return NO_DISCOUNTS;

  // See the input query for why there are two. `$app` is correct and current;
  // `app` is where an earlier silent namespace fallback put the configuration on
  // stores that are already live.
  const config =
    input.discount.appConfig?.jsonValue ?? input.discount.legacyConfig?.jsonValue;
  const tiers = config && Array.isArray(config.tiers) ? config.tiers : [];
  if (!tiers.length) return NO_DISCOUNTS;

  // Gift lines carry our attribute; everything else is what the customer chose.
  const giftLines = [];
  const ownLines = [];
  for (const line of input.cart.lines) {
    const tierId = line.giftTier?.value;
    if (tierId) giftLines.push({ line, tierId });
    else ownLines.push(line);
  }
  if (!giftLines.length) return NO_DISCOUNTS;

  const amountOf = (line) => Number(line.cost.subtotalAmount.amount);
  const productIdOf = (line) =>
    line.merchandise.__typename === 'ProductVariant' ? line.merchandise.product.id : null;

  /**
   * Cart money arrives in the CUSTOMER's presentment currency; a merchant types the
   * threshold in the SHOP's currency. On a single-currency store those are the same
   * thing and the rate is 1, which is why this went unnoticed — but on any store
   * using Shopify Markets they are not, and a shopper browsing in another currency
   * would be measured against a number that means nothing to them. A PKR 5,000 tier
   * compared against a $20 subtotal never fires.
   *
   * presentment = shop × rate, so shop = presentment ÷ rate. A missing or zero rate
   * falls back to 1: leaving the amount alone is right for the single-currency case
   * and is the only safe thing to do with a divisor we do not trust.
   *
   * The theme script applies the identical conversion, using Shopify.currency.rate.
   * They have to agree, or the theme hands out a gift the function will not discount.
   */
  const rate = Number(input.presentmentCurrencyRate);
  const inShopCurrency = (amount) => (rate > 0 ? amount / rate : amount);

  // Thresholds are judged only on the customer's own lines. Counting gift lines
  // would let a gift push the cart over — or under — its own threshold, which is
  // the feedback loop that made tiers flap on the storefront.
  const ownSubtotal = inShopCurrency(
    ownLines.reduce((sum, line) => sum + amountOf(line), 0),
  );

  /**
   * Which of the configured collections a line's product belongs to, as Shopify
   * itself reports it.
   *
   * This used to be answered from a list of every product id in the collection,
   * carried in the configuration metafield. That is what broke the app in
   * production: a metafield over 10,000 bytes is silently omitted from a function's
   * input, and a collection of ~500 products is already past that. The function then
   * saw null for its entire configuration — every tier, not just the collection one —
   * and discounted nothing. Nothing upstream looked wrong, because the Admin API
   * returns the same metafield without complaint.
   *
   * `inCollections` moves the question to where the answer already lives. The
   * configuration now carries one collection id per tier instead of thousands of
   * product ids, so its size no longer depends on how big the merchant's collections
   * are.
   */
  const membershipsOf = (line) =>
    line.merchandise.__typename === 'ProductVariant'
      ? (line.merchandise.product.inCollections ?? [])
      : [];

  const collectionsOf = (line) => {
    const ids = new Set();
    for (const membership of membershipsOf(line)) {
      if (membership.isMember) ids.add(membership.collectionId);
    }
    return ids;
  };

  /**
   * Which collections Shopify was actually ASKED about — every requested id comes back
   * on every variant line, member or not, so an id missing from here means it was
   * never in $collectionIds.
   *
   * This is the difference between "the product is not in that collection" and "we
   * have no idea", and the upgrade depends on telling them apart. $collectionIds is
   * fed by a metafield the admin only writes when a tier is saved, so on a store that
   * installed the new function but has not re-saved, the list is empty and every
   * lookup would answer "not a member" — silently switching off every collection tier
   * that was working a minute earlier. Falling back to the cached ids in that case
   * keeps those tiers running until the merchant's next save.
   *
   * The obvious shortcut — fall back whenever the live lookup matches no lines — is
   * wrong, because "no lines matched" is the correct answer most of the time, and
   * taking the stale cache there resurrects a product the merchant has since removed
   * from the collection. Two fixtures hold this line: upgrade-before-tier-resaved
   * fails if the fallback goes away, live-membership-overrides-stale-cache fails if
   * it becomes that shortcut. Neither one catches both mistakes alone.
   */
  const askedAbout = new Set();
  for (const line of input.cart.lines) {
    for (const membership of membershipsOf(line)) askedAbout.add(membership.collectionId);
  }

  /**
   * Product ids from a configuration written before the change above. Those configs
   * only survive at all when the collection was small enough to stay under the
   * limit, but a merchant who has not re-saved a tier should keep working until
   * they do.
   */
  const legacyMembers = (tier) => {
    const members = new Set(
      Array.isArray(tier.collectionProductGids) ? tier.collectionProductGids : [],
    );
    if (Array.isArray(tier.collectionProductIds)) {
      for (const id of tier.collectionProductIds) {
        members.add(`gid://shopify/Product/${id}`);
      }
    }
    return members;
  };

  const linesInCollection = (tier) => {
    if (tier.collectionGid && askedAbout.has(tier.collectionGid)) {
      return ownLines.filter((line) => collectionsOf(line).has(tier.collectionGid));
    }
    const members = legacyMembers(tier);
    if (!members.size) return [];
    return ownLines.filter((line) => {
      const productId = productIdOf(line);
      return productId !== null && members.has(productId);
    });
  };

  // A tier can be a window rather than a floor: "gift on orders of Rs 6,000 to
  // Rs 7,999" is threshold 6000 with thresholdMax 7999. Both ends are inclusive,
  // and no cap (absent, null, or zero) means the tier stays open-ended, which is
  // what every tier saved before this existed relies on.
  const withinRange = (value, tier) => {
    if (value < Number(tier.threshold ?? 0)) return false;
    const max = Number(tier.thresholdMax);
    return !(max > 0) || value <= max;
  };

  // How many items from the collection a `collection_contains` tier asks for.
  // Absent, zero or unparseable means 1, which is what every tier saved before this
  // field existed relies on.
  const minQuantity = (tier) => {
    const n = Number(tier.minQuantity);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };

  // Units, not lines. Five of one product is five items toward the requirement —
  // counting lines instead would call that one, which is not what a merchant asking
  // for "any 2 items from this collection" means.
  const unitsInCollection = (tier) =>
    linesInCollection(tier).reduce((n, line) => n + Number(line.quantity ?? 0), 0);

  const qualifies = (tier) => {
    switch (tier.type) {
      case 'order_subtotal':
        return withinRange(ownSubtotal, tier);
      case 'collection_contains':
        return unitsInCollection(tier) >= minQuantity(tier);
      case 'collection_subtotal':
        return withinRange(
          inShopCurrency(
            linesInCollection(tier).reduce((sum, line) => sum + amountOf(line), 0),
          ),
          tier,
        );
      default:
        return false;
    }
  };

  const tierById = new Map(tiers.filter((tier) => tier?.id).map((tier) => [tier.id, tier]));

  // Every tier stands on its own: a Rs 5,000 tier and a Rs 10,000 tier both pay
  // out on a Rs 12,000 cart, and a collection tier pays out alongside them.
  const candidates = [];
  const granted = new Set();
  for (const { line, tierId } of giftLines) {
    if (granted.has(tierId)) continue; // one free gift per tier
    const tier = tierById.get(tierId);
    if (!tier || tier.enabled === false) continue;
    if (!qualifies(tier)) continue;
    granted.add(tierId);
    candidates.push({
      message: tier.name || 'Free gift',
      targets: [{ cartLine: { id: line.id, quantity: 1 } }],
      value: { percentage: { value: 100 } },
    });
  }

  if (!candidates.length) return NO_DISCOUNTS;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // All, not First: each candidate is a separate tier's gift and they must
          // all be discounted. First would make only one gift free.
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
