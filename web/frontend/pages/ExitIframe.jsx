import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export default function ExitIframe() {
  const { search } = useLocation();

  useEffect(() => {
    if (!search) return;

    const params = new URLSearchParams(search);
    const redirectUri = params.get("redirectUri");

    if (!redirectUri) return;

    try {
      const decodedRedirectUri = decodeURIComponent(redirectUri);
      const url = new URL(decodedRedirectUri);

      if (url.hostname === window.location.hostname) {
        if (window.top) {
          window.top.location.href = decodedRedirectUri;
          return;
        }

        window.location.replace(decodedRedirectUri);
      }
    } catch {
      // Ignore malformed redirect URLs and leave the fallback UI rendered.
    }
  }, [search]);

  return <p style={{ padding: "2rem", textAlign: "center" }}>Redirecting…</p>;
}
