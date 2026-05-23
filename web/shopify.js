import { ApiVersion, BillingInterval } from "@shopify/shopify-api";
import { shopifyApp } from "@shopify/shopify-app-express";
import { MongoDBSessionStorage } from "@shopify/shopify-app-session-storage-mongodb";
import { restResources } from "@shopify/shopify-api/rest/admin/2025-07";
import {
  mongoDbName,
  mongoDbUrl,
  mongoSessionCollection,
} from "./mongo-config.js";
const PREMIUM_PLAN = "Premium";
const PREMIUM_PLAN_PRICE = 19;
const REQUIRED_BILLING_SCOPES = [
  "read_own_subscription",
  "write_own_subscription",
];
const shopifyHost = process.env.HOST?.replace(/https?:\/\//, "");
const shopifyScopes = (process.env.SCOPES || "")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);

const billingConfig = {
  [PREMIUM_PLAN]: {
    amount: PREMIUM_PLAN_PRICE,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
  },
};

if (!shopifyHost) {
  throw new Error("Missing HOST configuration for Shopify app setup.");
}

if (!shopifyScopes.length) {
  throw new Error("Missing SCOPES configuration for Shopify app setup.");
}

const missingBillingScopes = REQUIRED_BILLING_SCOPES.filter(
  (scope) => !shopifyScopes.includes(scope)
);

if (missingBillingScopes.length) {
  throw new Error(
    `Missing required Shopify billing scopes: ${missingBillingScopes.join(", ")}. Update SCOPES and reinstall or reauthorize the app.`
  );
}

const shopify = shopifyApp({
  api: {
    apiVersion: ApiVersion.July25,
    restResources,
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    hostName: shopifyHost,
    scopes: shopifyScopes,
    billing: billingConfig,
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  sessionStorage: new MongoDBSessionStorage(mongoDbUrl, mongoDbName, {
    sessionCollectionName: mongoSessionCollection,
  }),
});

export default shopify;
