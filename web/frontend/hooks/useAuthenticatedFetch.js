import { authenticatedFetch } from "@shopify/app-bridge-utils";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Redirect } from "@shopify/app-bridge/actions";

const RETURN_TO_STORAGE_KEY = "promomint:returnTo";
const PENDING_PLAN_STORAGE_KEY = "promomint:pendingPlan";
const REAUTH_GUARD_STORAGE_KEY = "promomint:reauthGuard";
const REAUTH_GUARD_WINDOW_MS = 60000;

/**
 * A hook that returns an auth-aware fetch function.
 * @desc The returned fetch function that matches the browser's fetch API
 * See: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
 * It will provide the following functionality:
 *
 * 1. Add a `X-Shopify-Access-Token` header to the request.
 * 2. Check response for `X-Shopify-API-Request-Failure-Reauthorize` header.
 * 3. Redirect the user to the reauthorization URL if the header is present.
 * 4. Redirect the user when backend JSON responses require reauthorization.
 *
 * @returns {Function} fetch function
 */
export class ReauthorizationInProgressError extends Error {
  constructor(message = "Shopify authentication is being restored.") {
    super(message);
    this.name = "ReauthorizationInProgressError";
  }
}

export const isReauthorizationInProgressError = (error) =>
  error instanceof ReauthorizationInProgressError ||
  error?.name === "ReauthorizationInProgressError";

export const hasRecentReauthAttempt = () => !!getRecentReauthAttempt();

export function useAuthenticatedFetch() {
  const app = useAppBridge();
  const fetchFunction = authenticatedFetch(app);

  return async (uri, options = {}) => {
    const { reauthPlan = "", ...fetchOptions } = options || {};
    let response = await fetchFunction(uri, fetchOptions);

    if (response.ok) {
      clearRecentReauthAttempt();
      return response;
    }

    // A 401 (or a reauthorize-header response) is usually just a stale session
    // token. App Bridge mints a fresh token on every authenticatedFetch call
    // and the backend re-exchanges it for an offline token, so retry once
    // silently before resorting to a heavy full-page reauthorization redirect.
    // A 401 means the request was rejected before the handler ran (getSession
    // returned null), so retrying a POST does not double-apply a mutation.
    if (shouldRetryBeforeReauth(response)) {
      const retryResponse = await fetchFunction(uri, fetchOptions);
      if (retryResponse.ok) {
        clearRecentReauthAttempt();
        return retryResponse;
      }
      response = retryResponse;
    }

    const headerHandled = await checkHeadersForReauthorization(
      response,
      app,
      reauthPlan
    );

    if (headerHandled) {
      throw new ReauthorizationInProgressError();
    }

    const jsonHandled = await checkJsonForReauthorization(
      response,
      app,
      reauthPlan
    );

    if (jsonHandled) {
      throw new ReauthorizationInProgressError();
    }

    return response;
  };
}

function shouldRetryBeforeReauth(response) {
  return (
    response.status === 401 ||
    response.headers.get("X-Shopify-API-Request-Failure-Reauthorize") === "1"
  );
}

async function checkHeadersForReauthorization(response, app, pendingPlan) {
  if (
    response.headers.get("X-Shopify-API-Request-Failure-Reauthorize") !== "1"
  ) {
    return false;
  }

  const authUrlHeader =
    response.headers.get("X-Shopify-API-Request-Failure-Reauthorize-Url") ||
    "/api/auth";

  return beginReauthorization(app, {
    authUrl: authUrlHeader,
    shop: getCurrentShop(),
    pendingPlan,
    reason: "session",
  });
}

async function checkJsonForReauthorization(response, app, pendingPlan) {
  if (response.status !== 401) {
    return false;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return false;
  }

  try {
    const data = await response.clone().json();
    if (!data?.needsReauth) {
      return false;
    }

    const reason = data.requiresBillingScopes ? "billing-scopes" : "session";
    return beginReauthorization(app, {
      authUrl: "/api/auth",
      shop: data.shop || getCurrentShop(),
      pendingPlan,
      reason,
    });
  } catch {
    return false;
  }
}

function beginReauthorization(app, { authUrl, shop, pendingPlan, reason }) {
  const currentRoute = getCurrentRoute();
  const currentHost = getCurrentHost();
  const resolvedAuthUrl = new URL(authUrl, `https://${window.location.host}`);
  const resolvedShop =
    shop || resolvedAuthUrl.searchParams.get("shop") || getCurrentShop();

  if (!resolvedShop) {
    return false;
  }

  // If any reauthorization is already in flight within the guard window, do
  // not fire another full-page redirect — regardless of route or reason. This
  // is what prevents the OAuth reload loop when several API calls 401 at once.
  const recentAttempt = getRecentReauthAttempt();
  if (recentAttempt) {
    return true;
  }

  window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, currentRoute);

  if (pendingPlan) {
    window.sessionStorage.setItem(PENDING_PLAN_STORAGE_KEY, pendingPlan);
  } else {
    window.sessionStorage.removeItem(PENDING_PLAN_STORAGE_KEY);
  }

  rememberReauthAttempt({ reason, route: currentRoute });

  if (!resolvedAuthUrl.searchParams.has("shop")) {
    resolvedAuthUrl.searchParams.set("shop", resolvedShop);
  }
  if (!resolvedAuthUrl.searchParams.has("returnTo")) {
    resolvedAuthUrl.searchParams.set("returnTo", currentRoute);
  }
  if (currentHost && !resolvedAuthUrl.searchParams.has("host")) {
    resolvedAuthUrl.searchParams.set("host", currentHost);
  }

  const redirect = Redirect.create(app);
  redirect.dispatch(Redirect.Action.REMOTE, resolvedAuthUrl.toString());
  return true;
}

function getCurrentRoute() {
  return `${window.location.pathname}${window.location.search}`;
}

function decodeHost(host) {
  if (!host) return "";

  try {
    return atob(host.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
}

function getCurrentHost() {
  const qs = new URLSearchParams(window.location.search);
  return qs.get("host") || window.__SHOPIFY_DEV_HOST || "";
}

function getCurrentShop() {
  const qs = new URLSearchParams(window.location.search);
  const fromUrl = qs.get("shop");
  if (fromUrl) return fromUrl;

  const decoded = decodeHost(getCurrentHost());
  if (!decoded) return "";

  const adminStoreMatch = decoded.match(/\/store\/([^/?]+)/);
  if (adminStoreMatch?.[1]) {
    return `${adminStoreMatch[1]}.myshopify.com`;
  }

  const directShopMatch = decoded.match(
    /([a-z0-9][a-z0-9-]*\.myshopify\.com)/i
  );

  return directShopMatch?.[1] || "";
}

function getRecentReauthAttempt() {
  const rawValue = window.sessionStorage.getItem(REAUTH_GUARD_STORAGE_KEY);
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed?.startedAt || !parsed?.reason || !parsed?.route) {
      window.sessionStorage.removeItem(REAUTH_GUARD_STORAGE_KEY);
      return null;
    }

    if (Date.now() - parsed.startedAt > REAUTH_GUARD_WINDOW_MS) {
      window.sessionStorage.removeItem(REAUTH_GUARD_STORAGE_KEY);
      return null;
    }

    return parsed;
  } catch {
    window.sessionStorage.removeItem(REAUTH_GUARD_STORAGE_KEY);
    return null;
  }
}

function rememberReauthAttempt({ reason, route }) {
  window.sessionStorage.setItem(
    REAUTH_GUARD_STORAGE_KEY,
    JSON.stringify({ reason, route, startedAt: Date.now() })
  );
}

function clearRecentReauthAttempt() {
  window.sessionStorage.removeItem(REAUTH_GUARD_STORAGE_KEY);
}
