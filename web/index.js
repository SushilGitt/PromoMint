// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import crypto from "crypto";
import express from "express";
import serveStatic from "serve-static";
import { BillingError } from "@shopify/shopify-api";

import shopify from "./shopify.js";
import cancelSubscription from "./cancel-subscription.js";
import GDPRWebhookHandlers from "./gdpr.js";
import "./env.js";

/* -------------------------------------------------------------------------- */
/*                                  CONFIG                                    */
/* -------------------------------------------------------------------------- */

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const PREMIUM_PLAN_SLUG = "premium";
const PREMIUM_PLAN = "Premium";

const APP_NAMESPACE = "custom";
const APP_META_KEY = "mx-pdp-coupon";

const APP_INSTALL_METAFIELD = "mx-pdp-coupon-code-premium";

const BILLING_TEST_MODE_ENV = "SHOPIFY_BILLING_TEST_MODE";

const parseBooleanEnv = (name) => {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim() === "") return null;

  const normalizedValue = rawValue.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalizedValue)) return true;
  if (["false", "0", "no"].includes(normalizedValue)) return false;

  throw new Error(
    `Invalid ${name} value "${rawValue}". Use true or false.`
  );
};

const resolvedBillingTestMode = (() => {
  const envOverride = parseBooleanEnv(BILLING_TEST_MODE_ENV);

  if (envOverride !== null) {
    return { isTest: envOverride, source: `${BILLING_TEST_MODE_ENV} override` };
  }

  return {
    isTest: process.env.NODE_ENV !== "production",
    source: "NODE_ENV default",
  };
})();

const BILLING_IS_TEST = resolvedBillingTestMode.isTest;

const APP_HOST = process.env.HOST?.trim();

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  INTERNAL_SERVER_ERROR: 500,
};

/* -------------------------------------------------------------------------- */
/*                               EXPRESS SERVER                               */
/* -------------------------------------------------------------------------- */

const app = express();
app.set("trust proxy", 1);

console.log(
  `[billing] Mode=${BILLING_IS_TEST ? "TEST" : "LIVE"} (${resolvedBillingTestMode.source})`
);

/* -------------------------------------------------------------------------- */
/*                           SHOPIFY WEBHOOKS                                 */
/* -------------------------------------------------------------------------- */

// Must be registered before any body parser. Shopify HMAC verification
// needs the raw request bytes; express.json() would consume the stream first.
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({
    webhookHandlers: {
      ...GDPRWebhookHandlers,
    },
  })
);

/* -------------------------------------------------------------------------- */
/*                              BODY PARSERS                                  */
/* -------------------------------------------------------------------------- */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------------------------------------------------------------- */
/*                              SHOPIFY AUTH                                  */
/* -------------------------------------------------------------------------- */

app.get(shopify.config.auth.path, shopify.auth.begin());

app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

/* -------------------------------------------------------------------------- */
/*                                UTILITIES                                   */
/* -------------------------------------------------------------------------- */

const createGraphQLClient = (session) =>
  new shopify.api.clients.Graphql({ session });

const handleError = (res, code, message) => {
  console.error(message);
  res.status(code).send({ error: message });
};

const getAppBaseUrl = (req) => {
  const forwardedProtocol = req.get("x-forwarded-proto");
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const protocol = forwardedProtocol || req.protocol;

  if (host && protocol) {
    return `${protocol}://${host}`;
  }

  return APP_HOST || "";
};

const decodeBase64Url = (value) => {
  if (!value) return "";

  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  try {
    return Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    return "";
  }
};

const getShopFromHostParam = (hostParam) => {
  const decodedHost = decodeBase64Url(hostParam);
  if (!decodedHost) return "";

  const adminStoreMatch = decodedHost.match(/\/store\/([^/?]+)/);
  if (adminStoreMatch?.[1]) {
    return `${adminStoreMatch[1]}.myshopify.com`;
  }

  const directShopMatch = decodedHost.match(
    /([a-z0-9][a-z0-9-]*\.myshopify\.com)/i
  );
  return directShopMatch?.[1] || "";
};

const loadSessionForShop = async (shop) => {
  if (!shop) return null;

  const offlineSessionId = shopify.api.session.getOfflineId(shop);
  const offlineSession =
    await shopify.config.sessionStorage.loadSession(offlineSessionId);

  if (offlineSession?.accessToken) {
    return offlineSession;
  }

  if (typeof shopify.config.sessionStorage.findSessionsByShop === "function") {
    const sessions =
      await shopify.config.sessionStorage.findSessionsByShop(shop);
    return (
      sessions.find((session) => !session.isOnline && session.accessToken) ||
      null
    );
  }

  return null;
};

const getShopFromRequest = async (req) => {
  const bearerToken = req.headers.authorization?.match(/Bearer (.*)/)?.[1];

  if (bearerToken) {
    try {
      const payload = await shopify.api.session.decodeSessionToken(bearerToken);
      const tokenShop = payload?.dest?.replace("https://", "") || "";
      if (tokenShop) return tokenShop;
    } catch {
      // Fall through to query and host resolution.
    }
  }

  const queryShop =
    typeof req.query.shop === "string" ? req.query.shop.trim() : "";
  if (queryShop) return queryShop;

  const hostParam =
    typeof req.query.host === "string" ? req.query.host.trim() : "";
  return getShopFromHostParam(hostParam);
};

const getSession = async (req, res) => {
  // Prefer the validated session from the validateAuthenticatedSession middleware
  if (res?.locals?.shopify?.session) {
    return res.locals.shopify.session;
  }
  // Fallback: manual resolution for routes without middleware
  const shop = await getShopFromRequest(req);
  return loadSessionForShop(shop);
};

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (typeof req.query.shop === "string" && req.query.shop.trim()) return next();

  const hostParam =
    typeof req.query.host === "string" ? req.query.host.trim() : "";
  const shop = getShopFromHostParam(hostParam);

  if (!shop) return next();

  const redirectUrl = new URL(
    getAppBaseUrl(req) || `${req.protocol}://${req.get("host")}`
  );
  redirectUrl.pathname = req.path;

  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => redirectUrl.searchParams.append(key, entry));
    } else if (typeof value === "string") {
      redirectUrl.searchParams.set(key, value);
    }
  }

  redirectUrl.searchParams.set("shop", shop);
  return res.redirect(302, redirectUrl.toString());
});

const isUnauthorizedError = (err) =>
  err?.response?.code === 401 ||
  err?.response?.code === 403 ||
  err?.code === 401 ||
  err?.code === 403 ||
  err?.statusCode === 401 ||
  err?.statusCode === 403 ||
  (typeof err?.message === "string" &&
    (err.message.includes("401") ||
      err.message.includes("403") ||
      err.message.toLowerCase().includes("unauthorized") ||
      err.message.toLowerCase().includes("forbidden")));

const formatBillingErrorDetails = (errorData = []) =>
  errorData
    .map((detail) => {
      if (typeof detail === "string") return detail;
      if (detail?.message) return detail.message;
      return "";
    })
    .filter(Boolean);

/* -------------------------------------------------------------------------- */
/*                               BILLING SERVICE                              */
/* -------------------------------------------------------------------------- */

const BillingService = {
  async checkSubscription(session) {
    return await shopify.api.billing.check({
      session,
      plans: [PREMIUM_PLAN],
      isTest: BILLING_IS_TEST,
      returnObject: true,
    });
  },

  async requestSubscription(session, returnUrl) {
    if (!returnUrl) {
      throw new Error(
        "Missing HOST configuration for Shopify billing return URL."
      );
    }

    return await shopify.api.billing.request({
      session,
      plan: PREMIUM_PLAN,
      isTest: BILLING_IS_TEST,
      returnUrl,
    });
  },

  async cancel(session) {
    return await cancelSubscription(session);
  },
};

/* -------------------------------------------------------------------------- */
/*                           SUBSCRIPTION SERVICE                             */
/* -------------------------------------------------------------------------- */

const SubscriptionService = {
  async getPlanTier(session) {
    const billing = await BillingService.checkSubscription(session);
    return billing?.hasActivePayment ? "premium" : "free";
  },
};

/* -------------------------------------------------------------------------- */
/*                            METAFIELD SERVICE                               */
/* -------------------------------------------------------------------------- */

const MetafieldService = {
  async getShopGid(session) {
    const client = createGraphQLClient(session);

    const query = `
      {
        shop {
          id
        }
      }
    `;

    const response = await client.request(query);
    const shopId = response?.shop?.id ?? response?.data?.shop?.id;

    if (!shopId) throw new Error("Shop ID not found");

    return shopId;
  },

  async setShopMetafield(session, tier) {
    const client = createGraphQLClient(session);

    const ownerId = await this.getShopGid(session);

    const value = tier === "premium" ? "premium" : "free";

    const result = await client.request(CREATE_APP_DATA_METAFIELD, {
      variables: {
        metafieldsSetInput: [
          {
            ownerId,
            namespace: APP_NAMESPACE,
            key: APP_META_KEY,
            type: "single_line_text_field",
            value,
          },
        ],
      },
    });

    const errors =
      result?.metafieldsSet?.userErrors ||
      result?.data?.metafieldsSet?.userErrors ||
      [];

    if (errors.length) {
      console.error("Metafield set error:", errors);
    }
  },

  async ensureAppMetafield(session) {
    const client = createGraphQLClient(session);

    const installation = await client.request(CURRENT_APP_INSTALLATION, {
      variables: { namespace: APP_NAMESPACE, key: APP_INSTALL_METAFIELD },
    });

    const ownerId = installation?.currentAppInstallation?.id;
    const existing = installation?.currentAppInstallation?.metafield;

    if (!existing && ownerId) {
      await client.request(CREATE_APP_DATA_METAFIELD, {
        variables: {
          metafieldsSetInput: [
            {
              namespace: APP_NAMESPACE,
              key: APP_INSTALL_METAFIELD,
              type: "boolean",
              value: "true",
              ownerId,
            },
          ],
        },
      });
    }
  },

  async deleteAppMetafield(session) {
    const client = createGraphQLClient(session);

    const installation = await client.request(CURRENT_APP_INSTALLATION, {
      variables: { namespace: APP_NAMESPACE, key: APP_INSTALL_METAFIELD },
    });

    const ownerId = installation?.currentAppInstallation?.id;
    const existing = installation?.currentAppInstallation?.metafield;

    if (ownerId && existing) {
      await client.request(APP_OWNED_METAFIELD_DELETE, {
        variables: {
          ownerId,
          namespace: APP_NAMESPACE,
          key: APP_INSTALL_METAFIELD,
        },
      });
    }
  },
};

/* -------------------------------------------------------------------------- */
/*                        PUBLIC SUBSCRIPTION CHECK                           */
/* -------------------------------------------------------------------------- */

// Verify that a request was signed by Shopify's app-proxy. Shopify appends
// `signature=<hex>` to the proxied query string, where the signature is
// HMAC-SHA256 of the remaining query params sorted alphabetically and joined
// as `key=value` (no separator), keyed by the app's API secret.
// https://shopify.dev/docs/apps/build/online-store/display-dynamic-data#calculate-a-digital-signature
const verifyAppProxySignature = (req) => {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;

  const { signature, ...rest } = req.query;
  if (typeof signature !== "string" || !signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = rest[key];
      const joined = Array.isArray(value) ? value.join(",") : String(value);
      return `${key}=${joined}`;
    })
    .join("");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  const provided = Buffer.from(signature, "utf8");
  const expected = Buffer.from(digest, "utf8");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
};

app.get("/api/scroll-to-top/hasSubscription", async (req, res) => {
  try {
    if (!verifyAppProxySignature(req)) {
      return handleError(
        res,
        HTTP_STATUS.UNAUTHORIZED,
        "Invalid app proxy signature"
      );
    }

    const { shop } = req.query;

    if (!shop) {
      return handleError(res, HTTP_STATUS.BAD_REQUEST, "Missing shop");
    }

    const session = await loadSessionForShop(shop);

    if (!session) {
      return handleError(res, HTTP_STATUS.UNAUTHORIZED, "Session not found");
    }

    const tier = await SubscriptionService.getPlanTier(session);

    await MetafieldService.setShopMetafield(session, tier);

    res.status(HTTP_STATUS.OK).send({
      hasActiveSubscription: tier !== "free",
      tier,
    });
  } catch (err) {
    handleError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, err.message);
  }
});

/* -------------------------------------------------------------------------- */
/*                         CREATE SUBSCRIPTION                                */
/* -------------------------------------------------------------------------- */

app.get("/api/createSubscription", async (req, res) => {
  let session;

  try {
    session = await getSession(req, res);
    console.log("[createSubscription] session resolved:", !!session, session?.shop);

    if (!session) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ needsReauth: true, shop: session?.shop });
    }

    const requestedPlan = String(req.query.plan || "").toLowerCase();

    if (requestedPlan !== PREMIUM_PLAN_SLUG) {
      return handleError(
        res,
        HTTP_STATUS.BAD_REQUEST,
        `Unsupported plan "${requestedPlan || "unknown"}"`
      );
    }

    const appBase = (APP_HOST || getAppBaseUrl(req)).replace(/\/+$/, "");
    const hostParam =
      typeof req.query.host === "string" ? req.query.host.trim() : "";
    const returnParams = new URLSearchParams();
    returnParams.set("shop", session.shop);
    if (hostParam) returnParams.set("host", hostParam);
    const billingReturnUrl = `${appBase}/?${returnParams.toString()}`;
    console.log("[createSubscription] billingReturnUrl:", billingReturnUrl);

    const billing = await BillingService.checkSubscription(session);
    console.log("[createSubscription] hasActivePayment:", billing?.hasActivePayment);

    if (billing?.hasActivePayment) {
      await MetafieldService.ensureAppMetafield(session);
      await MetafieldService.setShopMetafield(session, "premium");

      return res.send({
        isActiveSubscription: true,
        plan: PREMIUM_PLAN,
        tier: "premium",
      });
    }

    console.log("[createSubscription] requesting billing...");
    const billingResponse = await BillingService.requestSubscription(
      session,
      billingReturnUrl
    );
    console.log("[createSubscription] billingResponse type:", typeof billingResponse);

    const confirmationUrl =
      typeof billingResponse === "string"
        ? billingResponse
        : billingResponse?.confirmationUrl;

    console.log("[createSubscription] confirmationUrl:", confirmationUrl);

    if (!confirmationUrl) {
      throw new Error("Shopify did not return a billing confirmation URL.");
    }

    res.send({
      isActiveSubscription: false,
      plan: PREMIUM_PLAN,
      tier: "free",
      confirmationUrl,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("[createSubscription] error:", error.message, err);

    if (isUnauthorizedError(err)) {
      return res
        .status(HTTP_STATUS.UNAUTHORIZED)
        .json({ needsReauth: true, shop: session?.shop });
    }

    if (err instanceof BillingError) {
      const details = formatBillingErrorDetails(err.errorData);

      console.error("Billing request failed", {
        plan: PREMIUM_PLAN,
        shop: session?.shop,
        errorData: err.errorData,
      });

      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
        error: details[0] || err.message,
        details,
      });
    }

    handleError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, error.message);
  }
});

/* -------------------------------------------------------------------------- */
/*                         CANCEL SUBSCRIPTION                                */
/* -------------------------------------------------------------------------- */

app.get("/api/cancelSubscription", async (req, res) => {
  let session;

  try {
    session = await getSession(req, res);

    if (!session) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ needsReauth: true });
    }

    const billing = await BillingService.checkSubscription(session);

    if (!billing?.hasActivePayment) {
      return res.send({ status: "No subscription found" });
    }

    const status = await BillingService.cancel(session);

    await MetafieldService.deleteAppMetafield(session);
    await MetafieldService.setShopMetafield(session, "free");

    res.send({
      status,
      cancelledPlan: PREMIUM_PLAN,
    });
  } catch (err) {
    if (isUnauthorizedError(err)) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ needsReauth: true, shop: session?.shop });
    }
    handleError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, err.message);
  }
});

/* -------------------------------------------------------------------------- */
/*                        CHECK ACTIVE SUBSCRIPTION                           */
/* -------------------------------------------------------------------------- */

app.get("/api/hasActiveSubscription", async (req, res) => {
  let session;

  try {
    session = await getSession(req, res);

    if (!session) {
      return res.send({ hasActiveSubscription: false, tier: "free" });
    }

    const tier = await SubscriptionService.getPlanTier(session);

    if (tier === "free") {
      await MetafieldService.setShopMetafield(session, "free");
      return res.send({ hasActiveSubscription: false, tier: "free" });
    }

    await MetafieldService.ensureAppMetafield(session);
    await MetafieldService.setShopMetafield(session, "premium");

    res.send({ hasActiveSubscription: true, tier });
  } catch (err) {
    if (isUnauthorizedError(err)) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({ needsReauth: true, shop: session?.shop });
    }
    handleError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, err.message);
  }
});

/* -------------------------------------------------------------------------- */
/*                                SHOP INFO                                   */
/* -------------------------------------------------------------------------- */

app.get("/api/getshop", shopify.validateAuthenticatedSession(), async (req, res) => {
  const session = await getSession(req, res);
  res.json({ shop: session?.shop || null });
});

/* -------------------------------------------------------------------------- */
/*                              FRONTEND SERVING                              */
/* -------------------------------------------------------------------------- */

app.use(shopify.cspHeaders());

app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res) => {
  res
    .status(200)
    .set("Content-Type", "text/html")
    .send(readFileSync(join(STATIC_PATH, "index.html")));
});

app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);

/* -------------------------------------------------------------------------- */
/*                                GRAPHQL                                     */
/* -------------------------------------------------------------------------- */

const CURRENT_APP_INSTALLATION = `
query appSubscription($namespace: String!, $key: String!) {
  currentAppInstallation {
    id
    metafield(namespace: $namespace, key: $key) {
      namespace
      key
      value
      id
    }
  }
}
`;

const CREATE_APP_DATA_METAFIELD = `
mutation CreateAppDataMetafield($metafieldsSetInput: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafieldsSetInput) {
    metafields { id namespace key }
    userErrors { field message }
  }
}
`;

const APP_OWNED_METAFIELD_DELETE = `
mutation appOwnedMetafieldDelete($ownerId: ID!, $namespace: String!, $key: String!) {
  appOwnedMetafieldDelete(ownerId: $ownerId, namespace: $namespace, key: $key) {
    deletedId
    userErrors { field message }
  }
}
`;
