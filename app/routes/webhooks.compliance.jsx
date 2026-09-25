import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * The three mandatory compliance webhooks. Shopify requires a public app to be
 * subscribed to all of them, and to verify them, before it can be submitted for
 * review — so this route exists even though two of the three have nothing to do.
 *
 * `authenticate.webhook` is what does the verifying: it checks the HMAC and rejects
 * anything that doesn't match, so an unsigned POST never reaches the switch below.
 *
 * What this app actually stores is worth stating plainly, because it is the reason
 * the handlers are so short: tier configuration lives in Shopify metafields, not
 * here, and the only rows in our database are Shopify sessions (shop domain and
 * access token). No customer name, email, address, order or browsing data is ever
 * written, which also keeps the app at Level 0 for protected customer data.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // A customer asked the merchant for the data we hold on them. We hold none,
      // so there is nothing to hand back. Acknowledging is the correct response.
      break;

    case "CUSTOMERS_REDACT":
      // A customer asked to be erased. We never stored anything about them, so
      // there is nothing to erase.
      break;

    case "SHOP_REDACT":
      // Sent 48 hours after the app is uninstalled. app/uninstalled already clears
      // these rows, but that webhook can be missed, so this is the guaranteed sweep.
      await db.session.deleteMany({ where: { shop } });
      break;

    default:
      // An unexpected compliance topic is a configuration mistake, not a request we
      // can act on. Returning 401 tells Shopify to retry, which would never succeed.
      console.log(`Unhandled compliance topic ${topic} for ${shop}`);
      break;
  }

  return new Response();
};
