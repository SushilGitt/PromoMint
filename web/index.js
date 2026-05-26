// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import crypto from "crypto";
import express from "express";
import serveStatic from "serve-static";
import { BillingError, RequestedTokenType } from "@shopify/shopify-api";

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

const REQUIRED_WEBHOOK_TOPICS = [
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
  "SHOP_REDACT",
];

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

app.get(shopify.config.auth.callbackPath, async (req, res) => {
  try {
    const callbackResponse = await shopify.api.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });

    await shopify.config.sessionStorage.storeSession(callbackResponse.session);

    res.locals.shopify = {
      ...res.locals.shopify,
      session: callbackResponse.session,
    };

    if (!callbackResponse.session.isOnline) {
      const registrationResult = await shopify.api.webhooks.register({
        session: callbackResponse.session,
      });
      const failedTopics = getFailedWebhookTopics(registrationResult);

      if (failedTopics.length) {
        console.error("[auth/callback] Mandatory webhook registration failed:", {
          shop: callbackResponse.session.shop,
          failedTopics,
          registrationResult,
        });
        return res
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send("Mandatory Shopify compliance webhook registration failed.");
      }
    }

    const host = shopify.api.utils.sanitizeHost(req.query.host);
    const returnPath = sanitizeReturnPath(req.query.returnTo);
    let redirectUrl = await shopify.api.auth.getEmbeddedAppUrl({
      rawRequest: req,
      rawResponse: res,
    });

    redirectUrl = appendPathToEmbeddedUrl(redirectUrl, returnPath);

    if (host && !redirectUrl.includes("host=")) {
      const separator = redirectUrl.includes("?") ? "&" : "?";
      redirectUrl = `${redirectUrl}${separator}host=${encodeURIComponent(host)}`;
    }

    return res.redirect(redirectUrl);
  } catch (error) {
    console.error("[auth/callback] OAuth completion failed:", error);
    res.status(500).send(error instanceof Error ? error.message : String(error));
  }
});

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

const sanitizeReturnPath = (value) => {
  if (typeof value !== "string") return "";

  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith("/")) return "";
  if (trimmedValue.startsWith("//")) return "";

  try {
    const parsed = new URL(trimmedValue, "https://promomint.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
};

const appendPathToEmbeddedUrl = (embeddedUrl, returnPath) => {
  if (!returnPath) return embeddedUrl;

  try {
    const embedded = new URL(embeddedUrl);
    const destination = new URL(returnPath, `${embedded.origin}/`);
    destination.searchParams.forEach((value, key) => {
      if (!embedded.searchParams.has(key)) {
        embedded.searchParams.set(key, value);
      }
    });
    embedded.pathname = destination.pathname;
    return embedded.toString();
  } catch {
    return embeddedUrl;
  }
};

const getFailedWebhookTopics = (registrationResult) =>
  REQUIRED_WEBHOOK_TOPICS.filter((topic) => {
    const results = registrationResult?.[topic];
    return !Array.isArray(results) || results.some((result) => !result?.success);
  });

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

const getBearerTokenFromRequest = (req) =>
  req.headers.authorization?.match(/Bearer (.*)/)?.[1] || "";

const exchangeOfflineTokenFromRequest = async (req, shop) => {
  const sessionToken = getBearerTokenFromRequest(req);
  if (!sessionToken || !shop) return null;

  try {
    const { session } = await shopify.api.auth.tokenExchange({
      shop,
      sessionToken,
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
    });

    await shopify.config.sessionStorage.storeSession(session);
    return session;
  } catch (error) {
    console.warn("[session] Token exchange failed:", error);
    return null;
  }
};

const getShopFromRequest = async (req) => {
  const bearerToken = getBearerTokenFromRequest(req);

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

const resolveReauthShop = async (req, session) =>
  session?.shop || (await getShopFromRequest(req)) || "";

const sendReauthorizationRequired = async (req, res, session, extra = {}) => {
  const shop = await resolveReauthShop(req, session);
  return res.status(HTTP_STATUS.UNAUTHORIZED).json({
    needsReauth: true,
    shop,
    ...extra,
  });
};

const buildPricingReturnUrl = (req, shop, hostParam) => {
  const appBase = getAppBaseUrl(req).replace(/\/+$/, "");
  const sanitizedHost = shopify.api.utils.sanitizeHost(hostParam || "");

  if (!appBase) {
    throw new Error("Missing HOST configuration for Shopify billing return URL.");
  }

  if (!shop) {
    throw new Error("Missing shop for Shopify billing return URL.");
  }

  if (!sanitizedHost) {
    throw new Error("Missing host parameter for Shopify billing return URL.");
  }

  const returnParams = new URLSearchParams();
  returnParams.set("shop", shop);
  returnParams.set("host", sanitizedHost);

  return `${appBase}/pricing?${returnParams.toString()}`;
};

const getSession = async (req, res) => {
  if (res?.locals?.shopify?.session) {
    return res.locals.shopify.session;
  }

  const shop = await getShopFromRequest(req);
  const sessionToken = getBearerTokenFromRequest(req);

  if (sessionToken && shop) {
    const exchangedSession = await exchangeOfflineTokenFromRequest(req, shop);
    if (exchangedSession?.accessToken) {
      return exchangedSession;
    }
  }

  const storedSession = await loadSessionForShop(shop);
  if (storedSession?.accessToken) {
    return storedSession;
  }

  return null;
};

const refreshSessionFromRequest = async (req, shop) => {
  const resolvedShop = shop || (await getShopFromRequest(req));
  if (!resolvedShop) return null;
  return exchangeOfflineTokenFromRequest(req, resolvedShop);
};

const withSessionRefresh = async (req, session, action) => {
  try {
    return await action(session);
  } catch (error) {
    if (!isUnauthorizedError(error)) {
      throw error;
    }

    const refreshedSession = await refreshSessionFromRequest(req, session?.shop);
    if (!refreshedSession?.accessToken) {
      throw error;
    }

    return action(refreshedSession);
  }
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

const getErrorStatusCode = (err) => {
  const directStatusCode =
    err?.response?.code ||
    err?.response?.statusCode ||
    err?.response?.networkStatusCode ||
    err?.response?.response?.networkStatusCode ||
    err?.code ||
    err?.statusCode;

  if (typeof directStatusCode === "number") {
    return directStatusCode;
  }

  if (typeof directStatusCode === "string" && /^\d+$/.test(directStatusCode)) {
    return Number(directStatusCode);
  }

  if (Array.isArray(err?.errorData)) {
    for (const detail of err.errorData) {
      const nestedStatusCode =
        detail?.code ||
        detail?.statusCode ||
        detail?.networkStatusCode ||
        detail?.extensions?.code ||
        detail?.extensions?.statusCode ||
        detail?.extensions?.networkStatusCode ||
        detail?.response?.code ||
        detail?.response?.statusCode ||
        detail?.response?.networkStatusCode;

      if (typeof nestedStatusCode === "number") {
        return nestedStatusCode;
      }

      if (typeof nestedStatusCode === "string" && /^\d+$/.test(nestedStatusCode)) {
        return Number(nestedStatusCode);
      }
    }
  }

  if (typeof err?.message === "string") {
    const matchedStatusCode = err.message.match(/\b(401|403)\b/);
    if (matchedStatusCode) {
      return Number(matchedStatusCode[1]);
    }
  }

  return null;
};

const isUnauthorizedError = (err) => {
  const statusCode = getErrorStatusCode(err);
  if (statusCode === 401) return true;
  if (statusCode === 403 && !isBillingScopeError(err)) return true;

  if (typeof err?.message !== "string") return false;

  const message = err.message.toLowerCase();
  if (message.includes("401") || message.includes("unauthorized")) {
    return true;
  }

  return message.includes("403") || message.includes("forbidden")
    ? !isBillingScopeError(err)
    : false;
};

const formatBillingErrorDetails = (errorData = []) =>
  errorData
    .map((detail) => {
      if (typeof detail === "string") return detail;
      if (detail?.message) return detail.message;
      return "";
    })
    .filter(Boolean);

const isBillingScopeError = (err) => {
  if (!(err instanceof BillingError)) return false;
  if (getErrorStatusCode(err) !== 403) return false;

  const messageParts = [err.message, ...formatBillingErrorDetails(err.errorData)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    messageParts.includes("forbidden") ||
    messageParts.includes("scope") ||
    messageParts.includes("subscription") ||
    messageParts.includes("permission")
  );
};

const sendBillingReauthorizationRequired = (res, shop, details = []) =>
  res.status(HTTP_STATUS.UNAUTHORIZED).json({
    needsReauth: true,
    requiresBillingScopes: true,
    shop,
    error:
      "Shopify billing approval needs fresh app authorization with subscription scopes. Reinstall or reauthorize the app, then try Premium again.",
    details,
  });

/* -------------------------------------------------------------------------- */
/*                               BILLING SERVICE                              */
/* -------------------------------------------------------------------------- */
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
      return sendReauthorizationRequired(req, res, session);
    }

    const requestedPlan = String(req.query.plan || "").toLowerCase();

    if (requestedPlan !== PREMIUM_PLAN_SLUG) {
      return handleError(
        res,
        HTTP_STATUS.BAD_REQUEST,
        `Unsupported plan "${requestedPlan || "unknown"}"`
      );
    }

    const hostParam =
      typeof req.query.host === "string" ? req.query.host.trim() : "";
    const billingReturnUrl = buildPricingReturnUrl(
      req,
      session.shop,
      hostParam
    );
    console.log("[createSubscription] billingReturnUrl:", billingReturnUrl);

    let activeSession = session;
    const billing = await withSessionRefresh(req, session, async (resolvedSession) => {
      activeSession = resolvedSession;
      return BillingService.checkSubscription(resolvedSession);
    });
    session = activeSession;
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
    const billingResponse = await withSessionRefresh(
      req,
      session,
      async (resolvedSession) => {
        session = resolvedSession;
        return BillingService.requestSubscription(resolvedSession, billingReturnUrl);
      }
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

    if (err instanceof BillingError) {
      const details = formatBillingErrorDetails(err.errorData);

      console.error("Billing request failed", {
        plan: PREMIUM_PLAN,
        shop: session?.shop,
        statusCode: getErrorStatusCode(err),
        errorData: err.errorData,
      });

      if (isBillingScopeError(err)) {
        const reauthShop = await resolveReauthShop(req, session);
        return sendBillingReauthorizationRequired(res, reauthShop, details);
      }

      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
        error: details[0] || err.message,
        details,
      });
    }

    if (isUnauthorizedError(err)) {
      return sendReauthorizationRequired(req, res, session);
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
      return sendReauthorizationRequired(req, res, session);
    }

    let activeSession = session;
    const billing = await withSessionRefresh(req, session, async (resolvedSession) => {
      activeSession = resolvedSession;
      return BillingService.checkSubscription(resolvedSession);
    });
    session = activeSession;

    if (!billing?.hasActivePayment) {
      return res.send({ status: "No subscription found" });
    }

    const status = await withSessionRefresh(req, session, async (resolvedSession) => {
      session = resolvedSession;
      return BillingService.cancel(resolvedSession);
    });

    await MetafieldService.deleteAppMetafield(session);
    await MetafieldService.setShopMetafield(session, "free");

    res.send({
      status,
      cancelledPlan: PREMIUM_PLAN,
    });
  } catch (err) {
    if (err instanceof BillingError) {
      const details = formatBillingErrorDetails(err.errorData);

      if (isBillingScopeError(err)) {
        const reauthShop = await resolveReauthShop(req, session);
        return sendBillingReauthorizationRequired(res, reauthShop, details);
      }

      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
        error: details[0] || err.message,
        details,
      });
    }

    if (isUnauthorizedError(err)) {
      return sendReauthorizationRequired(req, res, session);
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
      return sendReauthorizationRequired(req, res, session, {
        error: "Authentication context is missing. Reopen the app from Shopify admin and try again.",
      });
    }

    let activeSession = session;
    const tier = await withSessionRefresh(req, session, async (resolvedSession) => {
      activeSession = resolvedSession;
      return SubscriptionService.getPlanTier(resolvedSession);
    });
    session = activeSession;

    if (tier === "free") {
      await MetafieldService.setShopMetafield(session, "free");
      return res.send({ hasActiveSubscription: false, tier: "free" });
    }

    await MetafieldService.ensureAppMetafield(session);
    await MetafieldService.setShopMetafield(session, "premium");

    res.send({ hasActiveSubscription: true, tier });
  } catch (err) {
    if (err instanceof BillingError) {
      const details = formatBillingErrorDetails(err.errorData);

      console.error("Active subscription check failed", {
        shop: session?.shop,
        statusCode: getErrorStatusCode(err),
        errorData: err.errorData,
      });

      if (isBillingScopeError(err)) {
        const reauthShop = await resolveReauthShop(req, session);
        return sendBillingReauthorizationRequired(res, reauthShop, details);
      }

      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
        error: details[0] || err.message,
        details,
      });
    }

    if (isUnauthorizedError(err)) {
      return sendReauthorizationRequired(req, res, session);
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
