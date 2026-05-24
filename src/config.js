import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: process.env.DATABASE_PATH || "./data/hub.sqlite",
  apiToken: process.env.HUB_API_TOKEN || "dev-token",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
  trustProxy: process.env.TRUST_PROXY === "true",
  clientOfflineAfterMs: Number(process.env.CLIENT_OFFLINE_AFTER_MS || 45_000)
};
