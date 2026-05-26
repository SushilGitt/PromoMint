// @ts-check
import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { promoMintColors, promoMintStyles } from "../brand";
import { CircleTickMinor } from "@shopify/polaris-icons";
import { Redirect } from "@shopify/app-bridge/actions";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useAuthenticatedFetch } from "../hooks";

const RETURN_TO_STORAGE_KEY = "promomint:returnTo";
const PENDING_PLAN_STORAGE_KEY = "promomint:pendingPlan";

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

  const [serverTier, setServerTier] = useState(null);
  const [loading, setLoading] = useState({ page: true, action: null });
  const [confirm, setConfirm] = useState({ open: false, target: null });
  const [banner, setBanner] = useState({ msg: "", status: null });
  const reauthInFlight = useRef(false);

  const PRICE = "19";

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
  const handleReauth = (data, pendingPlan = "") => {
    if (!data?.needsReauth) {
      return { redirected: false, blocked: false };
    }

    if (reauthInFlight.current) {
      return { redirected: true, blocked: false };
    }

    const reauthShop = shop || data.shop || "";
    if (!reauthShop) {
      setBanner({
        msg: "Authentication expired and store context is missing. Reopen the app from Shopify admin and try again.",
        status: "critical",
      });
      return { redirected: false, blocked: true };
    }

    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, returnTo);

    if (pendingPlan) {
      window.sessionStorage.setItem(PENDING_PLAN_STORAGE_KEY, pendingPlan);
    } else {
      window.sessionStorage.removeItem(PENDING_PLAN_STORAGE_KEY);
    }

    const authUrl = new URL(`/api/auth`, `https://${window.location.host}`);
    authUrl.searchParams.set("shop", reauthShop);
    authUrl.searchParams.set("returnTo", returnTo);
    if (host) {
      authUrl.searchParams.set("host", host);
    }

    reauthInFlight.current = true;
    redirect.dispatch(Redirect.Action.REMOTE, authUrl.toString());
    return { redirected: true, blocked: false };
  };

  const clearPendingPlan = () => {
    window.sessionStorage.removeItem(PENDING_PLAN_STORAGE_KEY);
  };

  const consumePendingPlanNotice = () => {
    const pendingPlan = window.sessionStorage.getItem(PENDING_PLAN_STORAGE_KEY);
    if (!pendingPlan) return;

    clearPendingPlan();
    setBanner({
      msg:
        pendingPlan === "premium"
          ? "Authentication restored. Choose Premium again to continue to Shopify billing approval."
          : "Authentication restored. Choose Free again to finish switching plans.",
      status: "info",
    });
  };

  const performPlanAction = async (plan) => {
    if (plan === "free") {
      const response = await fetchAuth(
        withShopQuery("/api/cancelSubscription")
      );

      const data = await parseJsonSafe(response);
      const reauthResult = handleReauth(data, "free");
      if (reauthResult.redirected) return { redirected: true };
      if (reauthResult.blocked) throw new Error(getErrorMessage(data, "Authentication context is missing."));

      if (!response.ok) {
        throw new Error(
          getErrorMessage(data, "We couldn’t switch you to the Free plan.")
        );
      }

      clearPendingPlan();
      await refreshTier();
      setBanner({ msg: "Your store is now on the Free plan.", status: "success" });
      return { redirected: false };
    }

    const res = await fetchAuth(
      withShopQuery("/api/createSubscription?plan=premium")
    );

    const data = await parseJsonSafe(res);
    const reauthResult = handleReauth(data, "premium");
    if (reauthResult.redirected) return { redirected: true };
    if (reauthResult.blocked) throw new Error(getErrorMessage(data, "Authentication context is missing."));

    if (!res.ok) {
      throw new Error(
        getErrorMessage(data, "We couldn’t start the Premium subscription.")
      );
    }

    if (data.isActiveSubscription) {
      clearPendingPlan();
      await refreshTier();
      setBanner({ msg: "Your Premium plan is already active.", status: "success" });
      return { redirected: false };
    }

    if (data.confirmationUrl) {
      clearPendingPlan();
      const confirmationUrl = String(data.confirmationUrl);
      redirect.dispatch(Redirect.Action.REMOTE, confirmationUrl);
      return { redirected: true };
    }

    throw new Error("Shopify did not return a billing approval link.");
  };

  useEffect(() => {
    consumePendingPlanNotice();
  }, []);

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
      const reauthResult = handleReauth(data);
      if (reauthResult.redirected || reauthResult.blocked) return;

      if (!res.ok || (data?.tier !== "premium" && data?.tier !== "free")) {
        throw new Error(getErrorMessage(data, "We couldn’t confirm your current plan."));
      }

      setServerTier(data.tier);
      setBanner((currentBanner) =>
        currentBanner.status === "critical" &&
        currentBanner.msg === "We couldn’t confirm your current plan."
          ? { msg: "", status: null }
          : currentBanner
      );
    } catch (error) {
      setServerTier(null);
      setBanner({
        msg:
          error instanceof Error
            ? error.message
            : "We couldn’t confirm your current plan.",
        status: "critical",
      });
    } finally {
      setLoading((s) => ({ ...s, page: false }));
    }
  }

  useEffect(() => {
    refreshTier();
  }, []);

  /* ---------- Change plan ---------- */

  const openConfirm = (plan) => {
    if (loading.page || loading.action || plan === selectedPlan) return;
    setConfirm({ open: true, target: plan });
  };

  const runConfirm = async () => {
    const plan = confirm.target;
    if (!plan || loading.page || loading.action) return;

    setConfirm({ open: false, target: null });
    setLoading((s) => ({ ...s, action: plan }));

    try {
      await performPlanAction(plan);
    } catch (error) {
      clearPendingPlan();
      setBanner({
        msg:
          error instanceof Error
            ? error.message
            : "We couldn’t start the Premium subscription.",
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
      <span style={{ fontSize: 14, color: promoMintColors.text }}>{children}</span>
    </Stack>
  );

  /* ---------- Styles ---------- */

  const cardStyle = (plan) => ({
    borderRadius: 20,
    border: isCurrent(plan)
      ? `2px solid ${promoMintColors.borderStrong}`
      : `1px solid ${promoMintColors.border}`,
    boxShadow: isCurrent(plan)
      ? `0 18px 45px ${promoMintColors.shadowStrong}`
      : `0 8px 24px ${promoMintColors.shadow}`,
    background:
      plan === "premium"
        ? `linear-gradient(180deg, #ffffff 0%, ${promoMintColors.indigoSoft} 100%)`
        : `linear-gradient(180deg, #ffffff 0%, ${promoMintColors.mintSoft} 100%)`,
    transform: isCurrent(plan) ? "translateY(-4px)" : "none",
    transition: "all 0.2s ease",
  });

  const currentBadge = {
    background: promoMintColors.indigo,
    color: "#fff",
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: 12,
  };

  const popularBadge = {
    background: promoMintColors.mint,
    color: promoMintColors.text,
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: 12,
  };

  const freeButtonStyle = promoMintStyles.secondaryButton;

  const premiumButtonStyle = promoMintStyles.primaryButton;

  const mutedTextStyle = { color: promoMintColors.mutedText };

  const pageIntroStyle = {
    color: promoMintColors.mutedText,
    marginBottom: 18,
  };

  const priceStyle = { fontSize: 34, color: promoMintColors.text };

  const sectionSpacingStyle = { marginTop: 14 };

  const actionSpacingStyle = { marginTop: 18 };

  const cardHeadingStyle = { color: promoMintColors.text };

  const planPageTitle = "Choose your PromoMint plan";

  const planIntro =
    "Pick the plan that matches how many coupon offers you want to feature on your product pages.";

  const planPageTitleContent = (
    <div style={pageIntroStyle}>{planIntro}</div>
  );

  const pageTitle = planPageTitle;

  const pageSubtitle = planPageTitleContent;

  const pageContent = (
    <Layout>
      <Layout.Section oneHalf>
        <Card sectioned style={cardStyle("free")}>
          <Stack alignment="center" distribution="equalSpacing">
            <h2 style={cardHeadingStyle}>Free</h2>
            {isCurrent("free") && (
              <span style={currentBadge}>Current</span>
            )}
          </Stack>

          <h1 style={priceStyle}>$0</h1>
          <p style={mutedTextStyle}>
            A simple option for smaller catalogs
          </p>

          <Stack vertical spacing="loose" style={sectionSpacingStyle}>
            <Feature>Display coupon offers on product pages</Feature>
            <Feature>Show up to 3 active offers</Feature>
            <Feature>Adjust colors and layout</Feature>
            <Feature>Keep slider arrow navigation</Feature>
            <Feature>Support mobile-friendly browsing</Feature>
          </Stack>

          <div style={actionSpacingStyle}>
            <Button
              fullWidth
              style={freeButtonStyle}
              disabled={isCurrent("free") || loading.page || !!loading.action || !selectedPlan}
              loading={loading.action === "free"}
              onClick={() => openConfirm("free")}
            >
              {isCurrent("free") ? "Active plan" : "Choose Free"}
            </Button>
          </div>
        </Card>
      </Layout.Section>

      <Layout.Section oneHalf>
        <Card sectioned style={cardStyle("premium")}>
          <Stack alignment="center" distribution="equalSpacing">
            <h2 style={cardHeadingStyle}>Premium</h2>
            {!isCurrent("premium") && (
              <span style={popularBadge}>Popular choice</span>
            )}
            {isCurrent("premium") && (
              <span style={currentBadge}>Current</span>
            )}
          </Stack>

          <h1 style={priceStyle}>${PRICE}</h1>
          <p style={mutedTextStyle}>
            More room for stores running multiple offers
          </p>

          <Stack vertical spacing="loose" style={sectionSpacingStyle}>
            <Feature>Display coupon offers on product pages</Feature>
            <Feature>Show up to 6 active offers</Feature>
            <Feature>Adjust colors and layout</Feature>
            <Feature>Keep slider arrow navigation</Feature>
            <Feature>Support mobile-friendly browsing</Feature>
          </Stack>

          <div style={actionSpacingStyle}>
            <Button
              fullWidth
              style={premiumButtonStyle}
              disabled={isCurrent("premium") || loading.page || !!loading.action || !selectedPlan}
              loading={loading.action === "premium"}
              onClick={() => openConfirm("premium")}
            >
              {isCurrent("premium")
                ? "Premium is active"
                : "Choose Premium"}
            </Button>
          </div>
        </Card>
      </Layout.Section>
    </Layout>
  );

  return (
    <>
      <Modal
        open={confirm.open}
        onClose={() => setConfirm({ open: false, target: null })}
        accessibilityLabel="Plan change confirmation"
        title={
          confirm.target === "free"
            ? "Move to the Free plan?"
            : "Continue with Premium?"
        }
        primaryAction={{
          content:
            confirm.target === "free"
              ? "Confirm Free plan"
              : `Approve $${PRICE}/month`,
          onAction: runConfirm,
          loading: loading.action === confirm.target,
          disabled: !confirm.target || loading.page || !!loading.action,
        }}
      >
        <Modal.Section>
          <TextContainer>
            <p>
              {confirm.target === "free"
                ? "The Free plan supports up to 3 coupon offers."
                : "The Premium plan supports up to 6 coupon offers."}
            </p>
          </TextContainer>
        </Modal.Section>
      </Modal>

      <Page title={pageTitle} subtitle={pageSubtitle}>
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
            We’re checking your current plan. You can still review the options
            below while that loads.
          </Banner>
        ) : null}

        {pageContent}
      </Page>
    </>
  );
}
