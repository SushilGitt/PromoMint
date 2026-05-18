import { DeliveryMethod } from "@shopify/shopify-api";
import shopify from "./shopify.js";

// PromoLoom data inventory (kept here so the rationale lives with the handlers
// that act on it):
//   - Offline Shopify sessions in MongoDB (shop domain + access token, keyed by
//     shopify.api.session.getOfflineId(shop)).
//   - Per-shop subscription tier persisted as a Shopify shop metafield
//     (`custom.mx-pdp-coupon`). That metafield is owned by the shop, so it is
//     cleared via Shopify, not by us.
// No customer-level PII is ever collected, stored, or processed by this app,
// so the customer-scoped compliance webhooks (customers/data_request,
// customers/redact) have no data to act on — they acknowledge receipt and
// return. shop/redact and app/uninstalled remove the shop's session row.

const deleteShopSessions = async (shop) => {
  const storage = shopify.config.sessionStorage;

  const offlineId = shopify.api.session.getOfflineId(shop);
  try {
    await storage.deleteSession(offlineId);
  } catch (err) {
    console.error(`[gdpr] deleteSession(${offlineId}) failed:`, err);
  }

  if (typeof storage.findSessionsByShop === "function") {
    try {
      const sessions = await storage.findSessionsByShop(shop);
      const ids = sessions.map((s) => s.id).filter(Boolean);
      if (ids.length && typeof storage.deleteSessions === "function") {
        await storage.deleteSessions(ids);
      }
    } catch (err) {
      console.error(`[gdpr] findSessionsByShop(${shop}) cleanup failed:`, err);
    }
  }
};

export default {
  /**
   * Customers can request their data from a store owner. When this happens,
   * Shopify invokes this webhook.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-data_request
   */
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      try {
        const payload = JSON.parse(body);
        const requestId = payload?.data_request?.id;
        console.log(
          `[gdpr] customers/data_request received shop=${shop} ` +
            `webhookId=${webhookId} requestId=${requestId} — ` +
            `no customer PII stored, nothing to return`
        );
      } catch (err) {
        console.error(`[gdpr] customers/data_request parse failed:`, err);
      }
    },
  },

  /**
   * Store owners can request that data is deleted on behalf of a customer.
   * PromoLoom does not store customer PII, so there is nothing to delete here.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-redact
   */
  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      try {
        const payload = JSON.parse(body);
        const customerId = payload?.customer?.id;
        console.log(
          `[gdpr] customers/redact received shop=${shop} ` +
            `webhookId=${webhookId} customerId=${customerId} — ` +
            `no customer PII stored, nothing to delete`
        );
      } catch (err) {
        console.error(`[gdpr] customers/redact parse failed:`, err);
      }
    },
  },

  /**
   * 48 hours after a store owner uninstalls the app, Shopify invokes this
   * webhook. We delete the offline session row for the shop from MongoDB.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#shop-redact
   */
  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, _body, webhookId) => {
      console.log(
        `[gdpr] shop/redact received shop=${shop} webhookId=${webhookId} — ` +
          `purging session rows`
      );
      await deleteShopSessions(shop);
    },
  },

  /**
   * Fired immediately when a merchant uninstalls the app. We delete the
   * offline session right away rather than waiting 48 hours for shop/redact,
   * so a reinstall starts from a clean slate.
   *
   * https://shopify.dev/docs/api/admin-rest/latest/resources/webhook#event-topics
   */
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, _body, webhookId) => {
      console.log(
        `[uninstall] app/uninstalled received shop=${shop} ` +
          `webhookId=${webhookId} — purging session rows`
      );
      await deleteShopSessions(shop);
    },
  },
};
