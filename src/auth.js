import crypto from "node:crypto";
import { config } from "./config.js";

export function requireWebAdmin(req, res, next) {
  if (req.path === "/health" || req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) {
    return next();
  }

  if (!config.webAdminUsername || !config.webAdminPassword) {
    return next();
  }

  const header = req.header("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return challenge(res);
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (!safeEqual(username, config.webAdminUsername) || !safeEqual(password, config.webAdminPassword)) {
    return challenge(res);
  }

  next();
}

function challenge(res) {
  res.set("www-authenticate", 'Basic realm="WhatsApp Actor Hub"');
  return res.status(401).send("Authentication required");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
