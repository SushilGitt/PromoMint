import "./env.js";

const rawMongoDbUrl = process.env.MONGODB_URI?.trim();
const rawMongoDbName = process.env.MONGODB_DB_NAME?.trim();
const mongoSessionCollection =
  process.env.MONGODB_SESSION_COLLECTION?.trim() || "shopify_sessions";

const normalizeMongoDbName = (name) => name.toLowerCase();

if (!rawMongoDbUrl || !rawMongoDbName) {
  throw new Error(
    "Missing MongoDB configuration. Set MONGODB_URI and MONGODB_DB_NAME in web/.env."
  );
}

const mongoDbName = normalizeMongoDbName(rawMongoDbName);

if (mongoDbName !== rawMongoDbName) {
  console.warn(
    `[mongo-config] Normalizing MONGODB_DB_NAME from "${rawMongoDbName}" to "${mongoDbName}" to avoid MongoDB case-collision issues.`
  );
}

export const mongoDbUrl = rawMongoDbUrl;
export { mongoDbName, mongoSessionCollection };
