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

function ResumePendingRoute() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const returnTo = window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
    if (!returnTo) return;

    const currentPath = `${location.pathname}${location.search}`;
    const isRootPath = location.pathname === "/";

    if (!isRootPath || currentPath === returnTo) {
      return;
    }

    window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
    navigate(returnTo, { replace: true });
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
            <ResumePendingRoute />
            <ErrorBoundary>
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
