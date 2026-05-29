# PromoLoom Deployment Checklist

## 1. VPS / Coolify environment variables

Set these runtime variables for the backend service:

```env
SHOPIFY_API_KEY=your_shopify_api_key
SHOPIFY_API_SECRET=your_shopify_api_secret
SCOPES=write_products,read_products
HOST=https://your-app-domain.com
PORT=3000
BACKEND_PORT=3000
MONGODB_URI=mongodb://username:password@your-mongodb-host:27017/admin?authSource=admin&directConnection=true
MONGODB_DB_NAME=promoloom
MONGODB_SESSION_COLLECTION=shopify_sessions
VITE_SHOPIFY_API_KEY=your_shopify_api_key
VITE_SHOPIFY_EXTENSION_UID=your_shopify_extension_uid
VITE_SHOPIFY_BLOCK_HANDLE=pdp-coupon
SHOPIFY_BILLING_TEST_MODE=true
```

Use a lowercase MongoDB database name such as `promoloom`. MongoDB can fail when a host already has the same database name in a different case.

Use the same `SHOPIFY_API_KEY`, `VITE_SHOPIFY_API_KEY`, `VITE_SHOPIFY_EXTENSION_UID`, and `VITE_SHOPIFY_BLOCK_HANDLE` as Docker **build args** (not just runtime env) if your platform separates build-time and runtime env vars. Vite bakes `VITE_SHOPIFY_API_KEY` into `frontend/dist/index.html` at build time so the App Bridge CDN script can read it from `<meta name="shopify-api-key">`; if it isn't set at build, the embedded-app auto-check on the Shopify partner dashboard will fail.

`VITE_SHOPIFY_API_KEY` should be the same value as `SHOPIFY_API_KEY` (the Shopify client id — public-safe).

`SHOPIFY_BILLING_TEST_MODE` is a runtime-only variable. Set it to `true` while validating billing on a dev store from the production deployment, then set it to `false` or remove it before testing real charges.

## 2. Docker / container settings

- Container port: `3000`
- Public app domain: `https://your-app-domain.com`
- Node environment: `production`

## 3. Shopify Partner Dashboard / app config

Update these values to your real production domain:

- App URL: `https://your-app-domain.com`
- Allowed redirection URL: `https://your-app-domain.com/api/auth/callback`
- App proxy URL: `https://your-app-domain.com/api/scroll-to-top`

If you use `shopify app config link` or maintain a TOML config, update:

- `application_url`
- `auth.redirect_urls`
- `app_proxy.url`

## 4. Smoke test before launch

1. Install the app on your test store.
2. Open the embedded app home page.
3. Click `Open Theme Editor`.
4. Open the pricing page.
5. Start the Premium subscription flow.
6. Load the storefront app proxy endpoint:
   `https://your-store.myshopify.com/apps/scroll-to-top/hasSubscription?shop=your-store.myshopify.com`

## 5. Known manual values

These values cannot be safely hardcoded in the repo because they depend on your live Shopify app and VPS domain:

- Production domain
- Shopify redirect URLs
- Shopify app proxy URL
- Production API key and secret
- Production MongoDB URI
