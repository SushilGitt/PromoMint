import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Layout,
  Page,
  TextContainer,
} from "@shopify/polaris";
import { promoMintColors, promoMintStyles } from "../brand";

export default function HomePage() {
  const navigate = useNavigate();

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
                To get started, open your theme editor, add the PromoMint app
                block to your product template, and update the offer text and
                coupon codes you want to show.
              </p>
            </TextContainer>
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card sectioned title="Getting started" style={promoMintStyles.accentCard}>
            <TextContainer spacing="loose">
              <p style={{ color: promoMintColors.mutedText }}>
                Open your live theme in the editor, place the PromoMint block on
                the product template, and save the offer details you want
                customers to see.
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
              <Button style={promoMintStyles.primaryButton} onClick={() => navigate("/pricing")}>
                See plan details
              </Button>
            </TextContainer>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
