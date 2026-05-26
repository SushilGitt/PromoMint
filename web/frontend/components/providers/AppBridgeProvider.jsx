import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Provider } from "@shopify/app-bridge-react";
import { Banner, Layout, Page } from "@shopify/polaris";

const decodeHost = (host) => {
  if (!host) return "";

  try {
    return atob(host.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
};

const getEmbeddedShop = (host) => {
  const decodedHost = decodeHost(host);
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

const withEmbeddedParams = (path, currentSearch) => {
  if (!path.startsWith("/")) {
    return path;
  }

  const [pathname, existingQuery = ""] = path.split("?");
  const nextParams = new URLSearchParams(existingQuery);
  const currentParams = new URLSearchParams(currentSearch);
  const host = currentParams.get("host") || window.__SHOPIFY_DEV_HOST || "";
  const shop = currentParams.get("shop") || getEmbeddedShop(host);

  if (host && !nextParams.has("host")) {
    nextParams.set("host", host);
  }

  if (shop && !nextParams.has("shop")) {
    nextParams.set("shop", shop);
  }

  const query = nextParams.toString();
  return query ? `${pathname}?${query}` : pathname;
};

const getStableEmbeddedSearch = (search) => {
  const params = new URLSearchParams(search);
  const host = params.get("host") || window.__SHOPIFY_DEV_HOST || "";
  const shop = params.get("shop") || getEmbeddedShop(host);
  const embeddedParams = new URLSearchParams();

  if (host) {
    embeddedParams.set("host", host);
  }

  if (shop) {
    embeddedParams.set("shop", shop);
  }

  return embeddedParams.toString();
};

/**
 * A component to configure App Bridge.
 * @desc A thin wrapper around AppBridgeProvider that provides the following capabilities:
 *
 * 1. Ensures that navigating inside the app updates the host URL.
 * 2. Configures the App Bridge Provider, which unlocks functionality provided by the host.
 *
 * See: https://shopify.dev/apps/tools/app-bridge/getting-started/using-react
 */
export function AppBridgeProvider({ children }) {
  const shopifyApiKey = process.env.SHOPIFY_API_KEY;
  const location = useLocation();
  const navigate = useNavigate();
  const embeddedSearch = useMemo(
    () => getStableEmbeddedSearch(location.search),
    [location.search]
  );
  const embeddedLocation = useMemo(
    () => ({
      ...location,
      search: embeddedSearch ? `?${embeddedSearch}` : "",
    }),
    [embeddedSearch, location]
  );
  const history = useMemo(
    () => ({
      replace: (path) => {
        navigate(withEmbeddedParams(path, embeddedLocation.search), {
          replace: true,
        });
      },
    }),
    [embeddedLocation.search, navigate]
  );

  const routerConfig = useMemo(
    () => ({ history, location: embeddedLocation }),
    [embeddedLocation, history]
  );

  // The host may be present initially, but later removed by navigation.
  // By caching this in state, we ensure that the host is never lost.
  // During the lifecycle of an app, these values should never be updated anyway.
  // Using state in this way is preferable to useMemo.
  // See: https://stackoverflow.com/questions/60482318/version-of-usememo-for-caching-a-value-that-will-never-change
  const [appBridgeConfig] = useState(() => {
    const host =
      new URLSearchParams(location.search).get("host") ||
      window.__SHOPIFY_DEV_HOST;

    window.__SHOPIFY_DEV_HOST = host;

    return {
      host,
      apiKey: shopifyApiKey,
      forceRedirect: true,
    };
  });

  if (!shopifyApiKey || !appBridgeConfig.host) {
    const bannerProps = !shopifyApiKey
      ? {
          title: "Shopify API key is missing",
          children: (
            <>
              This app is running without the SHOPIFY_API_KEY environment
              variable. Add it before starting or building the React app.
            </>
          ),
        }
      : {
          title: "Host parameter is missing",
          children: (
            <>
              This app can only load when the URL includes a <b>host</b>
              parameter. Add it to the URL, or launch the app from the
              Partners Dashboard <b>Test your app</b> option.
            </>
          ),
        };

    return (
      <Page narrowWidth>
        <Layout>
          <Layout.Section>
            <div style={{ marginTop: "100px" }}>
              <Banner {...bannerProps} status="critical" />
            </div>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Provider config={appBridgeConfig} router={routerConfig}>
      {children}
    </Provider>
  );
}
