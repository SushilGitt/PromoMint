import { useNavigate, useLocation } from "react-router-dom";
import {
  Button,
  Card,
  Layout,
  Page,
  TextContainer,
} from "@shopify/polaris";
import { promoMintColors, promoMintStyles } from "../brand";

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

export default function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <Page title="PromoMint">
      <Layout>
        <Layout.Section>
          <Card sectioned style={promoMintStyles.heroCard}>
            <TextContainer spacing="loose">
              <h2 style={{ color: promoMintColors.text }}>Display coupon offers where shoppers need them</h2>
              <p style={{ color: promoMintColors.mutedText }}>
                PromoMint lets you place coupon offers directly on product pages
                so customers can spot available savings and copy codes quickly.
              </p>
              <p style={{ color: promoMintColors.mutedText }}>
                To get started, open your theme editor, open a product
                template, add the PromoMint Coupon Offers app block, and update
                the offer text and coupon codes you want to show.
              </p>
            </TextContainer>
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card sectioned title="Getting started" style={promoMintStyles.accentCard}>
            <TextContainer spacing="loose">
              <p style={{ color: promoMintColors.mutedText }}>
                Open your live theme in the editor, place the PromoMint Coupon
                Offers app block on the product template, and save the offer
                details you want customers to see.
              </p>
            </TextContainer>
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card sectioned title="Plans" style={promoMintStyles.accentCard}>
            <TextContainer spacing="loose">
              <p style={{ color: promoMintColors.mutedText }}>
                Compare the available plan options and choose the one that fits
                your store.
              </p>
              <Button
                style={promoMintStyles.primaryButton}
                onClick={() =>
                  navigate(withEmbeddedParams("/pricing", location.search))
                }
              >
                See plan details
              </Button>
            </TextContainer>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
