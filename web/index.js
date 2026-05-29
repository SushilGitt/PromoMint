// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import crypto from "crypto";
import express from "express";
import serveStatic from "serve-static";
import { BillingError, RequestedTokenType } from "@shopify/shopify-api";

import shopify from "./shopify.js";
import cancelSubscription, {
  getActiveSubscriptions,
} from "./cancel-subscription.js";
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
const AUTH_RETURN_TO_COOKIE = "promomint_auth_return_to";

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

const setAuthReturnToCookie = (res, returnPath) => {
  if (!returnPath) {
    return;
  }

  res.cookie(AUTH_RETURN_TO_COOKIE, encodeURIComponent(returnPath), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60 * 1000,
  });
};

const clearAuthReturnToCookie = (res) => {
  res.clearCookie(AUTH_RETURN_TO_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
};

const readAuthReturnToCookie = (req) => {
  const cookieHeader = req.headers.cookie || "";
  if (!cookieHeader) {
    return "";
  }

  const cookieValue = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${AUTH_RETURN_TO_COOKIE}=`))
    ?.slice(AUTH_RETURN_TO_COOKIE.length + 1);

  if (!cookieValue) {
    return "";
  }

  try {
    return sanitizeReturnPath(decodeURIComponent(cookieValue));
  } catch {
    return "";
  }
};

/* -------------------------------------------------------------------------- */
/*                              SHOPIFY AUTH                                  */
/* -------------------------------------------------------------------------- */

app.get(shopify.config.auth.path, (req, res, next) => {
  const returnPath = sanitizeReturnPath(req.query.returnTo);
  if (returnPath) {
    setAuthReturnToCookie(res, returnPath);
  }

  return shopify.auth.begin()(req, res, next);
});

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

    // Compliance webhooks (customers/data_request, customers/redact,
    // shop/redact) and app/uninstalled are declared in shopify.app.toml and
    // managed by Shopify — they are NOT registerable via the Admin GraphQL
    // API. No manual webhook registration is needed here.

    const host = shopify.api.utils.sanitizeHost(req.query.host);
    const returnPath =
      sanitizeReturnPath(req.query.returnTo) || readAuthReturnToCookie(req);
    clearAuthReturnToCookie(res);
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

const getAppShellReturnPath = (req) => {
  if (req.method !== "GET") return "";
  if (req.path.startsWith("/api/")) return "";

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (typeof entry === "string") {
          query.append(key, entry);
        }
      });
      continue;
    }

    if (typeof value === "string") {
      query.set(key, value);
    }
  }

  const queryString = query.toString();
  return sanitizeReturnPath(
    `${req.path}${queryString ? `?${queryString}` : ""}`
  );
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
  returnParams.set("billingReturn", "1");
  returnParams.set("plan", PREMIUM_PLAN_SLUG);

  return `${appBase}/pricing?${returnParams.toString()}`;
};

const getBillingModeLabel = (isTest) => (isTest ? "TEST" : "LIVE");

const normalizeSubscriptionMode = (subscription) => {
  if (typeof subscription?.test === "boolean") {
    return subscription.test;
  }

  return null;
};

const findModeMismatchSubscription = (subscriptions = []) =>
  subscriptions.find((subscription) => {
    if (subscription?.name !== PREMIUM_PLAN) {
      return false;
    }

    const mode = normalizeSubscriptionMode(subscription);
    return mode !== null && mode !== BILLING_IS_TEST;
  }) || null;

const buildModeMismatchDetails = (subscription) => {
  if (!subscription) {
    return [];
  }

  return [
    `An active ${PREMIUM_PLAN} subscription exists in ${getBillingModeLabel(subscription.test)} mode while this app is running in ${getBillingModeLabel(BILLING_IS_TEST)} mode. Update ${BILLING_TEST_MODE_ENV} so both modes match.`,
  ];
};

const sendBillingModeMismatch = (res, subscription, extra = {}) => {
  const details = buildModeMismatchDetails(subscription);
  const subscriptionMode =
    normalizeSubscriptionMode(subscription) === null
      ? null
      : getBillingModeLabel(subscription.test);

  return res.status(HTTP_STATUS.BAD_REQUEST).json({
    billingModeMismatch: true,
    mode: getBillingModeLabel(BILLING_IS_TEST),
    appMode: getBillingModeLabel(BILLING_IS_TEST),
    subscriptionMode,
    details,
    error: details[0],
    ...extra,
  });
};

const syncTierMetafield = async (session, tier, options = {}) => {
  const { ensureInstallation = false, deleteInstallation = false } = options;

  try {
    if (ensureInstallation) {
      await MetafieldService.ensureAppMetafield(session);
    }

    if (deleteInstallation) {
      await MetafieldService.deleteAppMetafield(session);
    }

    await MetafieldService.setShopMetafield(session, tier);
    return { ok: true };
  } catch (error) {
    console.error("[metafield] Subscription tier sync failed", {
      shop: session?.shop,
      tier,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const checkBillingState = async (req, session) => {
  let resolvedSession = session;
  const billing = await withSessionRefresh(req, session, async (nextSession) => {
    resolvedSession = nextSession;
    return BillingService.checkSubscription(nextSession);
  });

  let mismatchSubscription = null;
  if (!billing?.hasActivePayment) {
    const subscriptions = await withSessionRefresh(
      req,
      resolvedSession,
      async (nextSession) => {
        resolvedSession = nextSession;
        return getActiveSubscriptions(nextSession);
      }
    );

    mismatchSubscription = findModeMismatchSubscription(subscriptions);
  }

  return {
    session: resolvedSession,
    billing,
    mismatchSubscription,
  };
};

const withBillingErrorHandling = async (req, res, session, err, contextLabel) => {
  // Shared context so no billing/session failure is ever silent again. The
  // granted scopes are the key signal for diagnosing a "Forbidden" from the
  // billing API (a token missing read_own_subscription).
  const logContext = {
    shop: session?.shop,
    statusCode: getErrorStatusCode(err),
    name: err?.name,
    message: err instanceof Error ? err.message : String(err),
    grantedScopes: session?.scope,
  };

  if (err instanceof BillingError) {
    const details = formatBillingErrorDetails(err.errorData);

    console.error(`${contextLabel} failed (BillingError)`, {
      ...logContext,
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

  if (isForbiddenScopeError(err)) {
    console.error(
      `${contextLabel} forbidden — access token likely missing billing scopes`,
      logContext
    );
    const reauthShop = await resolveReauthShop(req, session);
    return sendBillingReauthorizationRequired(res, reauthShop);
  }

  if (isUnauthorizedError(err)) {
    console.warn(
      `${contextLabel} unauthorized — requesting session reauthorization`,
      logContext
    );
    return sendReauthorizationRequired(req, res, session);
  }

  console.error(`${contextLabel} failed (unhandled)`, logContext);
  const error = err instanceof Error ? err : new Error(String(err));
  return handleError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, error.message);
};

const getEmbeddedParam = (source, key) => {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
};

const buildEmbeddedParams = (source = {}) => {
  const params = new URLSearchParams();
  const shop = getEmbeddedParam(source, "shop");
  const host = getEmbeddedParam(source, "host");

  if (shop) {
    params.set("shop", shop);
  }

  if (host) {
    params.set("host", host);
  }

  return params;
};

const sendPlanResponse = (res, payload, metafieldSync) =>
  res.send({
    ...payload,
    billingMode: getBillingModeLabel(BILLING_IS_TEST),
    metafieldSync,
  });

const getRequestedPlan = (req) => {
  const source = req.method === "POST" ? req.body : req.query;
  return String(source?.plan || "").toLowerCase();
};

const getHostFromRequest = (req) => {
  const queryHost = getEmbeddedParam(req.query, "host");
  if (queryHost) {
    return queryHost;
  }

  return getEmbeddedParam(req.body, "host");
};

const requireAuthenticatedBillingSession = async (req, res, next) => {
  try {
    if (!getBearerTokenFromRequest(req)) {
      return sendReauthorizationRequired(req, res, null, {
        error: "Authentication context is missing. Reopen the app from Shopify admin and try again.",
      });
    }

    return shopify.validateAuthenticatedSession()(req, res, next);
  } catch (error) {
    return next(error);
  }
};

const runBillingEndpoint = (handler, { requireValidatedSession = false } = {}) => {
  const middleware = [];

  if (requireValidatedSession) {
    middleware.push(requireAuthenticatedBillingSession);
  }

  middleware.push(async (req, res) => {
    let session;

    try {
      session = await getSession(req, res);

      if (!session) {
        console.warn("[session] No usable session for billing request", {
          shop: await getShopFromRequest(req),
          hadBearer: !!getBearerTokenFromRequest(req),
        });
        return sendReauthorizationRequired(req, res, session, {
          error: "Authentication context is missing. Reopen the app from Shopify admin and try again.",
        });
      }

      return await handler(req, res, session);
    } catch (err) {
      return withBillingErrorHandling(req, res, session, err, "Billing request");
    }
  });

  return middleware;
};

const respondUnsupportedBillingMethod = (res, allowedMethod) =>
  res.status(405).json({
    error: `Use ${allowedMethod} for this billing action.`,
  });

const bridgeBillingGetToPost = (allowedMethod) => async (req, res) => {
  if (allowedMethod !== "POST") {
    return respondUnsupportedBillingMethod(res, allowedMethod);
  }

  const embeddedParams = buildEmbeddedParams(req.query);
  const plan = getRequestedPlan(req);
  if (plan) {
    embeddedParams.set("plan", plan);
  }

  req.method = "POST";
  req.url = req.path;
  req.body = Object.fromEntries(embeddedParams.entries());

  return app._router.handle(req, res, () => undefined);
};

const normalizePlanCheckResponse = (tier) => ({
  hasActiveSubscription: tier === "premium",
  isActiveSubscription: tier === "premium",
  tier,
  plan: tier === "premium" ? PREMIUM_PLAN : null,
});

const normalizePlanMutationResponse = ({ tier, confirmationUrl = null }) => ({
  hasActiveSubscription: tier === "premium",
  isActiveSubscription: tier === "premium",
  tier,
  plan: tier === "premium" ? PREMIUM_PLAN : null,
  confirmationUrl,
});

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

// A 403 from billing.check / the Admin API is usually NOT a BillingError (it's
// a GraphqlQueryError / HttpResponseError) and almost always means the access
// token is missing billing scopes (read_own_subscription). Treat it as a
// billing-scope reauth so the merchant re-grants instead of looping silently
// through plain session reauthorization.
const isForbiddenScopeError = (err) => {
  if (getErrorStatusCode(err) !== 403) return false;

  const messageParts = [
    err?.message,
    ...(Array.isArray(err?.errorData) ? formatBillingErrorDetails(err.errorData) : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    messageParts.includes("forbidden") ||
    messageParts.includes("scope") ||
    messageParts.includes("permission") ||
    messageParts.includes("access denied") ||
    messageParts.includes("not approved")
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
    return await cancelSubscription(session, {
      expectedTestMode: BILLING_IS_TEST,
    });
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

    const billing = await BillingService.checkSubscription(session);
    const mismatchSubscription = !billing?.hasActivePayment
      ? findModeMismatchSubscription(await getActiveSubscriptions(session))
      : null;

    if (mismatchSubscription) {
      return sendBillingModeMismatch(res, mismatchSubscription, { shop });
    }

    const tier = billing?.hasActivePayment ? "premium" : "free";
    const metafieldSync = await syncTierMetafield(session, tier, {
      ensureInstallation: tier === "premium",
    });

    res.status(HTTP_STATUS.OK).send({
      ...normalizePlanCheckResponse(tier),
      billingMode: getBillingModeLabel(BILLING_IS_TEST),
      metafieldSync,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    handleError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, error.message);
  }
});

app.get("/api/createSubscription", bridgeBillingGetToPost("POST"));
app.get("/api/cancelSubscription", bridgeBillingGetToPost("POST"));
app.post(
  "/api/createSubscription",
  ...runBillingEndpoint(async (req, res, session) => {
    const requestedPlan = getRequestedPlan(req);

    if (requestedPlan !== PREMIUM_PLAN_SLUG) {
      return handleError(
        res,
        HTTP_STATUS.BAD_REQUEST,
        `Unsupported plan "${requestedPlan || "unknown"}"`
      );
    }

    const billingReturnUrl = buildPricingReturnUrl(
      req,
      session.shop,
      getHostFromRequest(req)
    );

    const billingState = await checkBillingState(req, session);
    session = billingState.session;

    if (billingState.mismatchSubscription) {
      return sendBillingModeMismatch(res, billingState.mismatchSubscription, {
        shop: session.shop,
      });
    }

    if (billingState.billing?.hasActivePayment) {
      const metafieldSync = await syncTierMetafield(session, "premium", {
        ensureInstallation: true,
      });

      return sendPlanResponse(
        res,
        normalizePlanMutationResponse({ tier: "premium" }),
        metafieldSync
      );
    }

    const billingResponse = await withSessionRefresh(
      req,
      session,
      async (resolvedSession) => {
        session = resolvedSession;
        return BillingService.requestSubscription(resolvedSession, billingReturnUrl);
      }
    );

    const confirmationUrl =
      typeof billingResponse === "string"
        ? billingResponse
        : billingResponse?.confirmationUrl;

    if (!confirmationUrl) {
      throw new Error("Shopify did not return a billing confirmation URL.");
    }

    return sendPlanResponse(
      res,
      normalizePlanMutationResponse({
        tier: "free",
        confirmationUrl,
      }),
      { ok: true }
    );
  })
);

app.post(
  "/api/cancelSubscription",
  ...runBillingEndpoint(async (req, res, session) => {
    const billingState = await checkBillingState(req, session);
    session = billingState.session;

    if (billingState.mismatchSubscription) {
      return sendBillingModeMismatch(res, billingState.mismatchSubscription, {
        shop: session.shop,
      });
    }

    if (!billingState.billing?.hasActivePayment) {
      const metafieldSync = await syncTierMetafield(session, "free", {
        deleteInstallation: true,
      });

      return sendPlanResponse(
        res,
        {
          ...normalizePlanMutationResponse({ tier: "free" }),
          status: "No subscription found",
          cancelledPlan: null,
        },
        metafieldSync
      );
    }

    const status = await withSessionRefresh(req, session, async (resolvedSession) => {
      session = resolvedSession;
      return BillingService.cancel(resolvedSession);
    });

    const metafieldSync = await syncTierMetafield(session, "free", {
      deleteInstallation: true,
    });

    return sendPlanResponse(
      res,
      {
        ...normalizePlanMutationResponse({ tier: "free" }),
        status,
        cancelledPlan: PREMIUM_PLAN,
      },
      metafieldSync
    );
  })
);

app.get(
  "/api/hasActiveSubscription",
  ...runBillingEndpoint(async (req, res, session) => {
    const billingState = await checkBillingState(req, session);
    session = billingState.session;

    if (billingState.mismatchSubscription) {
      return sendBillingModeMismatch(res, billingState.mismatchSubscription, {
        shop: session.shop,
      });
    }

    const tier = billingState.billing?.hasActivePayment ? "premium" : "free";
    const metafieldSync = await syncTierMetafield(session, tier, {
      ensureInstallation: tier === "premium",
      deleteInstallation: tier === "free",
    });

    return sendPlanResponse(
      res,
      normalizePlanCheckResponse(tier),
      metafieldSync
    );
  })
);

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

app.use("/*", (req, res, next) => {
  const returnPath = getAppShellReturnPath(req);
  if (returnPath) {
    setAuthReturnToCookie(res, returnPath);
  }

  next();
});

// Serve the SPA shell unconditionally. The HTML holds no secrets — it boots
// App Bridge, which mints a session token that the backend exchanges for an
// offline token on the first API call (see getSession ->
// exchangeOfflineTokenFromRequest). Gating the document request on
// ensureInstalledOnShop() caused an OAuth reload loop whenever Shopify loaded
// the embedded iframe without a resolvable shop param. First install still
// runs through Shopify's managed OAuth callback (/api/auth/callback).
app.use("/*", async (_req, res) => {
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
