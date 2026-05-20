import React from "react";
import { Banner, Card, Layout, Page, TextContainer } from "@shopify/polaris";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("App render error:", error, errorInfo);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <Page title="Something went wrong">
        <Layout>
          <Layout.Section>
            <Banner title="The app ran into a display error" status="critical">
              <p>Review the details below to identify the component that failed to render.</p>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Card sectioned>
              <TextContainer spacing="loose">
                <p>
                  <strong>Message:</strong> {this.state.error.message}
                </p>
                {this.state.error.stack ? (
                  <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>
                    <code>{this.state.error.stack}</code>
                  </pre>
                ) : null}
              </TextContainer>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }
}
