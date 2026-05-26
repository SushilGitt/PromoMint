import { useEffect } from "react";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { NavigationMenu } from "@shopify/app-bridge-react";
import Routes from "./Routes";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  AppBridgeProvider,
  QueryProvider,
  PolarisProvider,
} from "./components";

const RETURN_TO_STORAGE_KEY = "promomint:returnTo";

function ResumeStoredRoute() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const storedRoute = window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
    if (!storedRoute) return;

    const currentRoute = `${location.pathname}${location.search}`;
    if (storedRoute === currentRoute) {
      window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
      return;
    }

    if (!storedRoute.startsWith("/")) {
      window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
      return;
    }

    window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
    navigate(storedRoute, { replace: true });
  }, [location.pathname, location.search, navigate]);

  return null;
}

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
              <ResumeStoredRoute />
              <NavigationMenu
                navigationLinks={[
                  { label: "Overview", destination: "/" },
                  { label: "Plans", destination: "/pricing" },
                  { label: "Help", destination: "/support" },
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
