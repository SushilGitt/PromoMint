import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Layout,
  Page,
  TextContainer,
} from "@shopify/polaris";

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <Page title="PromoLoom">
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <TextContainer spacing="loose">
              <h2>Coupons for product pages</h2>
              <p>
                PromoLoom helps you show coupon offers directly on product pages
                so customers can copy codes faster.
              </p>
              <p>
                Start by opening the theme editor, adding the PromoLoom app
                block to your product template, and then configuring your offer
                titles and coupon codes.
              </p>
            </TextContainer>
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card sectioned title="Setup">
            <TextContainer spacing="loose">
              <p>Open your active theme editor and insert the PromoLoom block.</p>
            </TextContainer>
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card sectioned title="Plans">
            <TextContainer spacing="loose">
              <p>Review the available free and premium options for your store.</p>
              <Button onClick={() => navigate("/pricing")}>View Pricing</Button>
            </TextContainer>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
