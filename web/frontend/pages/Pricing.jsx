// @ts-check
import React, { useEffect, useMemo, useState } from "react";
import {
  Page,
  Layout,
  Card,
  Button,
  Banner,
  Stack,
  Modal,
  TextContainer,
  Icon,
} from "@shopify/polaris";
import { CircleTickMinor } from "@shopify/polaris-icons";
import { Redirect } from "@shopify/app-bridge/actions";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useAuthenticatedFetch } from "../hooks";

export default function Pricing() {
  const app = useAppBridge();
  const fetchAuth = useAuthenticatedFetch();
  const redirect = Redirect.create(app);
  const REQUEST_TIMEOUT_MS = 8000;
  const shop = (() => {
    const qs = new URLSearchParams(window.location.search);
    const fromUrl = qs.get("shop");
    if (fromUrl) return fromUrl;

    // After App Bridge navigation the ?shop= param is often stripped.
    // Decode the shop name from the host parameter that App Bridge caches.
    try {
      const host = qs.get("host") || window.__SHOPIFY_DEV_HOST;
      if (host) {
        const decoded = atob(host);
        const match = decoded.match(/\/store\/([^/]+)/);
        if (match) return `${match[1]}.myshopify.com`;
      }
    } catch { /* ignore decode errors */ }

    return "";
  })();

  const host = (() => {
    const qs = new URLSearchParams(window.location.search);
    return qs.get("host") || window.__SHOPIFY_DEV_HOST || "";
  })();

  const tick = useMemo(
    () => <Icon source={CircleTickMinor} color="success" />,
    []
  );

  const [serverTier, setServerTier] = useState("free");
  const [loading, setLoading] = useState({ page: true, action: null });
  const [confirm, setConfirm] = useState({ open: false, target: null });
  const [banner, setBanner] = useState({ msg: "", status: null });

  const PRICE = "149";

  const selectedPlan = useMemo(() => {
    if (!serverTier) return null;
    return serverTier === "premium" ? "premium" : "free";
  }, [serverTier]);

  const withShopQuery = (path) => {
    if (!shop && !host) return path;
    const [base, existingQuery = ""] = path.split("?");
    const params = new URLSearchParams(existingQuery);
    if (shop && !params.has("shop")) params.set("shop", shop);
    if (host && !params.has("host")) params.set("host", host);
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  };

  const getErrorMessage = (data, fallback) => {
    if (Array.isArray(data?.details) && data.details.length) {
      return data.details.join(" ");
    }

    return data?.error || fallback;
  };

  const parseJsonSafe = async (response) => {
    try {
      return await response.json();
    } catch {
      return {};
    }
  };

  /**
   * If the backend says the session is expired, redirect the merchant
   * through Shopify OAuth to get a fresh offline access token.
   * Returns true if a redirect was triggered (caller should bail out).
   */
  const handleReauth = (data) => {
    if (!data?.needsReauth) return false;

    const reauthShop = shop || data.shop || "";
    if (!reauthShop) return false;

    const authUrl = `https://${window.location.host}/api/auth?shop=${encodeURIComponent(reauthShop)}`;
    redirect.dispatch(Redirect.Action.REMOTE, authUrl);
    return true;
  };

  /* ---------- Load current plan ---------- */

  async function refreshTier() {
    try {
      setLoading((s) => ({ ...s, page: true }));
      const timeout = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("Loading plans took too long.")),
          REQUEST_TIMEOUT_MS
        );
      });

      const res = await Promise.race([
        fetchAuth(withShopQuery("/api/hasActiveSubscription")),
        timeout,
      ]);

      const data = await parseJsonSafe(res);
      if (handleReauth(data)) return;

      setServerTier(data?.tier === "premium" ? "premium" : "free");
    } catch {
      setServerTier("free");
    } finally {
      setLoading((s) => ({ ...s, page: false }));
    }
  }

  useEffect(() => {
    refreshTier();
  }, []);

  /* ---------- Change plan ---------- */

  const openConfirm = (plan) => {
    if (plan === selectedPlan) return;
    setConfirm({ open: true, target: plan });
  };

  const runConfirm = async () => {
    const plan = confirm.target;
    setConfirm({ open: false, target: null });
    setLoading((s) => ({ ...s, action: plan }));

    try {
      if (plan === "free") {
        const response = await fetchAuth(
          withShopQuery("/api/cancelSubscription")
        );

        const data = await parseJsonSafe(response);
        if (handleReauth(data)) return;

        if (!response.ok) {
          throw new Error(
            getErrorMessage(data, "Failed to switch to the Free plan.")
          );
        }

        await refreshTier();
        setBanner({ msg: "Switched to Free plan", status: "success" });
        return;
      }

      const res = await fetchAuth(
        withShopQuery("/api/createSubscription?plan=premium")
      );

      const data = await parseJsonSafe(res);
      if (handleReauth(data)) return;

      if (!res.ok) {
        throw new Error(
          getErrorMessage(data, "Failed to start the Premium subscription.")
        );
      }

      if (data.isActiveSubscription) {
        await refreshTier();
        setBanner({ msg: "Premium plan is already active.", status: "success" });
        return;
      }

      if (data.confirmationUrl) {
        const confirmationUrl = String(data.confirmationUrl);
        redirect.dispatch(Redirect.Action.REMOTE, confirmationUrl);
        return;
      }

      throw new Error("No Shopify billing confirmation URL was returned.");
    } catch (error) {
      setBanner({
        msg:
          error instanceof Error
            ? error.message
            : "Failed to start the Premium subscription.",
        status: "critical",
      });
    } finally {
      setLoading((s) => ({ ...s, action: null }));
    }
  };

  const isCurrent = (plan) => selectedPlan === plan;

  /* ---------- UI helpers ---------- */

  const Feature = ({ children }) => (
    <Stack spacing="tight" alignment="center">
      {tick}
      <span style={{ fontSize: 14 }}>{children}</span>
    </Stack>
  );

  /* ---------- Styles ---------- */

  const cardStyle = (plan) => ({
    borderRadius: 18,
    border: isCurrent(plan)
      ? "2px solid #2563EB"
      : "1px solid #E5E7EB",
    boxShadow: isCurrent(plan)
      ? "0 18px 45px rgba(37,99,235,0.25)"
      : "0 4px 14px rgba(15,23,42,0.06)",
    transform: isCurrent(plan) ? "translateY(-4px)" : "none",
    transition: "all 0.2s ease",
  });

  const currentBadge = {
    background: "#2563EB",
    color: "#fff",
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: 12,
  };

  const popularBadge = {
    background: "#F59E0B",
    color: "#111",
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: 12,
  };

  /* Attractive Free button gradient */
  const freeButtonStyle = {
    background: "linear-gradient(135deg,#ef4444,#dc2626)",
    color: "#fff",
    border: "none",
    fontWeight: 600,
  };

  const premiumButtonStyle = {
    background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
    color: "#fff",
    border: "none",
    fontWeight: 600,
  };

  return (
    <>
      <Modal
        open={confirm.open}
        onClose={() => setConfirm({ open: false, target: null })}
        accessibilityLabel="Plan change confirmation"
        title={
          confirm.target === "free"
            ? "Switch to Free plan?"
            : "Upgrade to Premium?"
        }
        primaryAction={{
          content:
            confirm.target === "free"
              ? "Switch to Free"
              : `Subscribe $${PRICE}/month`,
          onAction: runConfirm,
          loading: loading.action === confirm.target,
        }}
      >
        <Modal.Section>
          <TextContainer>
            <p>
              {confirm.target === "free"
                ? "Free plan allows up to 3 coupons."
                : "Premium plan allows up to 6 coupons."}
            </p>
          </TextContainer>
        </Modal.Section>
      </Modal>

      <Page title="PromoLoom Plans">
        {!!banner.msg && (
          <Banner
            status={banner.status}
            onDismiss={() => setBanner({ msg: "", status: null })}
          >
            {banner.msg}
          </Banner>
        )}

        {loading.page ? (
          <Banner status="info">
            Loading your current plan. You can still review the available plans
            below.
          </Banner>
        ) : null}

        <Layout>
          <Layout.Section oneHalf>
            <Card sectioned style={cardStyle("free")}>
              <Stack alignment="center" distribution="equalSpacing">
                <h2>Free</h2>
                {isCurrent("free") && (
                  <span style={currentBadge}>Current</span>
                )}
              </Stack>

              <h1 style={{ fontSize: 34 }}>$0</h1>
              <p style={{ color: "#6B7280" }}>
                Perfect for small stores
              </p>

              <Stack vertical spacing="loose" style={{ marginTop: 14 }}>
                <Feature>Show coupons on product pages</Feature>
                <Feature>Up to 3 coupons</Feature>
                <Feature>Customize colors & layout</Feature>
                <Feature>Slider arrow controls</Feature>
                <Feature>Mobile responsive slider</Feature>
              </Stack>

              <div style={{ marginTop: 18 }}>
                <Button
                  fullWidth
                  style={freeButtonStyle}
                  disabled={isCurrent("free") || loading.page}
                  loading={loading.action === "free"}
                  onClick={() => openConfirm("free")}
                >
                  {isCurrent("free") ? "Current plan" : "Switch to Free"}
                </Button>
              </div>
            </Card>
          </Layout.Section>

          <Layout.Section oneHalf>
            <Card sectioned style={cardStyle("premium")}>
              <Stack alignment="center" distribution="equalSpacing">
                <h2>Premium</h2>
                {!isCurrent("premium") && (
                  <span style={popularBadge}>Most popular</span>
                )}
                {isCurrent("premium") && (
                  <span style={currentBadge}>Current</span>
                )}
              </Stack>

              <h1 style={{ fontSize: 34 }}>${PRICE}</h1>
              <p style={{ color: "#6B7280" }}>
                Advanced features for growing stores
              </p>

              <Stack vertical spacing="loose" style={{ marginTop: 14 }}>
                <Feature>Show coupons on product pages</Feature>
                <Feature>Up to 6 coupons</Feature>
                <Feature>Customize colors & layout</Feature>
                <Feature>Slider arrow controls</Feature>
                <Feature>Mobile responsive slider</Feature>
              </Stack>

              <div style={{ marginTop: 18 }}>
                <Button
                  fullWidth
                  style={premiumButtonStyle}
                  disabled={isCurrent("premium") || loading.page}
                  loading={loading.action === "premium"}
                  onClick={() => openConfirm("premium")}
                >
                  {isCurrent("premium")
                    ? "Premium active"
                    : "Upgrade to Premium"}
                </Button>
              </div>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}
