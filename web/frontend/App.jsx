import { BrowserRouter } from "react-router-dom";
import { NavigationMenu } from "@shopify/app-bridge-react";
import Routes from "./Routes";
import { ErrorBoundary } from "./components/ErrorBoundary";

import {
  AppBridgeProvider,
  QueryProvider,
  PolarisProvider,
} from "./components";

export default function App() {
  // Any .tsx or .jsx files in /pages will become a route
  // See documentation for <Routes /> for more info
  const pages = import.meta.globEager("./pages/**/!(*.test.[jt]sx)*.([jt]sx)");

  return (
    <BrowserRouter>
      <AppBridgeProvider>
        <PolarisProvider>
          <QueryProvider>
            <ErrorBoundary>
              <NavigationMenu
                navigationLinks={[
                  { label: "Pricing", destination: "/pricing" },
                ]}
              />
              <Routes pages={pages} />
            </ErrorBoundary>
          </QueryProvider>
        </PolarisProvider>
      </AppBridgeProvider>
    </BrowserRouter>
  );
}
