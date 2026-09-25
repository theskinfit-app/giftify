/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const NO_ERRORS = { operations: [] };

/**
 * One free gift per tier, enforced where the customer cannot get around it.
 *
 * A gift line is tagged with the `_gift` attribute when the theme script adds it,
 * and the script always adds exactly one. Any gift line with a higher quantity is
 * therefore somebody else's write — in practice a theme addressing cart lines by
 * 1-based index, whose indices shifted when the gift was inserted, so the shopper's
 * own "set this line to 7" landed on the gift instead.
 *
 * The theme script clamps that in flight, but it is storefront JavaScript and there
 * are ways past it: a cart form posting its cached `updates` during the navigation
 * to checkout, an express checkout that never renders the cart, a shopper with
 * scripts blocked. This function runs on Shopify's servers in the online store cart
 * and throughout checkout, so it is the one place the rule actually holds.
 *
 * It deliberately reports a single error rather than one per line: the shopper only
 * needs to be told once, and repeating it per gift reads like something is badly
 * broken.
 *
 * @param {RunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const lines = input?.cart?.lines ?? [];

  const inflated = lines.some(
    (line) => Boolean(line.giftTier?.value) && Number(line.quantity) > 1,
  );
  if (!inflated) return NO_ERRORS;

  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              // Addressed at the cart as a whole: the shopper did not choose this
              // quantity, so pointing at a specific line would only confuse them.
              target: '$.cart',
              message:
                'A free gift is limited to one per order. Please update your cart to continue.',
            },
          ],
        },
      },
    ],
  };
}
