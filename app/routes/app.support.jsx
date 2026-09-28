// app/routes/app.support.jsx
// Uses Polaris web components (loaded via polaris.js in root). No @shopify/polaris import.

// ---------------------------------------------------------------------------
// FILL THESE IN BEFORE SUBMITTING TO THE APP STORE.
// A blank field is simply not rendered, so an unfinished page never shows an empty
// row or a broken link — but a support page with no way to reach anyone will not
// survive review.
// ---------------------------------------------------------------------------
const SUPPORT = {
  email: "myousuf035@gmail.com",
  // Leave blank until there is a real public documentation page. This previously
  // pointed at a .myshopify.com development store: password-protected, so a
  // reviewer clicking "Documentation" would hit a login wall, and it exposed the
  // test store's address to every merchant.
  docsUrl: "",
  responseTime: "within 1 business day",
};

export default function SupportPage() {
  const hasContact = SUPPORT.email || SUPPORT.docsUrl;

  return (
    <s-page heading="Help & support">
      <s-section heading="Before anything else: turn on the app embed">
        <s-paragraph>
          Gifts are added to the cart by a theme app embed, and it is off by default.
          If tiers are set up correctly but no gift ever appears, this is almost always
          why.
        </s-paragraph>
        <s-paragraph>
          Go to <s-text fontWeight="bold">Online Store → Themes → Customize → App embeds</s-text>{" "}
          and switch on <s-text fontWeight="bold">Free Gift</s-text>. Save the theme, then
          reload your storefront.
        </s-paragraph>
      </s-section>

      <s-section heading="If a gift still isn't appearing">
        <s-unordered-list>
          <s-list-item>
            The tier is <s-text fontWeight="bold">Active</s-text> on the Home page — a paused
            tier hands out nothing.
          </s-list-item>
          <s-list-item>
            The cart actually meets the condition. Thresholds use the currency of your store, so a
            threshold of 6000 on a USD store means $6,000.
          </s-list-item>
          <s-list-item>
            The gift product is in stock and available on the Online Store sales channel.
            A gift that cannot be added to a cart is skipped.
          </s-list-item>
          <s-list-item>
            The Home page shows no red banner. If it reports that the Free Gift discount is not
            running, open any tier and save it — that rebuilds the discount.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="How it works">
        <s-paragraph>
          Each tier watches the cart for its condition — an order subtotal, the subtotal of
          items from one collection, or a number of items from one collection. When the
          condition is met the gift is added to the cart, and the discount from this app makes that
          line free. If the cart changes and the condition no longer holds, the gift is
          removed again.
        </s-paragraph>
        <s-paragraph>
          Tiers stack: a 5,000 tier and a 10,000 tier both pay out on a 12,000 cart, and
          one gift is given per qualifying tier per order.
        </s-paragraph>
      </s-section>

      {hasContact && (
        <s-section slot="aside" heading="Contact us">
          {SUPPORT.email && (
            <s-paragraph>
              <s-link href={`mailto:${SUPPORT.email}`}>{SUPPORT.email}</s-link>
            </s-paragraph>
          )}
          {SUPPORT.responseTime && (
            <s-paragraph>
              <s-text tone="subdued">We reply {SUPPORT.responseTime}.</s-text>
            </s-paragraph>
          )}
          {SUPPORT.docsUrl && (
            <s-paragraph>
              <s-link href={SUPPORT.docsUrl} target="_blank">
                Documentation
              </s-link>
            </s-paragraph>
          )}
          <s-paragraph>
            <s-text tone="subdued">
              Telling us the store URL and which tier is affected gets the fastest answer.
            </s-text>
          </s-paragraph>
        </s-section>
      )}
    </s-page>
  );
}
