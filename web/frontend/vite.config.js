import { defineConfig, loadEnv } from "vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ""), ...process.env };
  const shopifyApiKey = env.SHOPIFY_API_KEY || env.VITE_SHOPIFY_API_KEY || "";
  const frontendPort = Number(env.FRONTEND_PORT) || 3001;
  const backendPort = Number(env.BACKEND_PORT) || 3000;
  const host = env.HOST ? env.HOST.replace(/https?:\/\//, "") : "localhost";

  if (env.npm_lifecycle_event === "build" && !env.CI && !shopifyApiKey) {
    console.warn(
      "\nBuilding the frontend app without a SHOPIFY_API_KEY. Set it before building or use Shopify CLI dev.\n"
    );
  }

  const proxyOptions = {
    target: `http://127.0.0.1:${backendPort}`,
    changeOrigin: false,
    secure: true,
    ws: false,
  };

  const hmr =
    host === "localhost"
      ? {
          protocol: "ws",
          host: "localhost",
          port: 64999,
          clientPort: 64999,
        }
      : {
          protocol: "wss",
          host,
          port: frontendPort,
          clientPort: 443,
        };

  // Vite 2 doesn't natively substitute %VAR% placeholders in index.html
  // (that's a Vite 3+ feature), so we do it ourselves. The App Bridge CDN
  // script reads the API key from <meta name="shopify-api-key">; without
  // this substitution the meta value stays literal "%VITE_SHOPIFY_API_KEY%"
  // and Shopify's embedded-app auto-check fails.
  const htmlEnvSubstitution = {
    name: "html-env-substitution",
    transformIndexHtml(html) {
      return html.replace(
        /%(VITE_[A-Z0-9_]+)%/g,
        (match, key) => env[key] ?? match
      );
    },
  };

  return {
    root,
    plugins: [react(), htmlEnvSubstitution],
    define: {
      "process.env.SHOPIFY_API_KEY": JSON.stringify(shopifyApiKey),
    },
    resolve: {
      alias: [
        {
          find: /^@shopify\/app-bridge-core$/,
          replacement: resolve(root, "node_modules/@shopify/app-bridge-core"),
        },
        {
          find: /^@shopify\/app-bridge-core\/(.*)$/,
          replacement: `${resolve(
            root,
            "node_modules/@shopify/app-bridge-core"
          )}/$1`,
        },
      ],
      preserveSymlinks: true,
    },
    server: {
      host: "localhost",
      port: frontendPort,
      hmr,
      proxy: {
        "^/(\\?.*)?$": proxyOptions,
        "^/api(/|(\\?.*)?$)": proxyOptions,
      },
    },
  };
});
