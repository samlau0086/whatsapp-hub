import crypto from "node:crypto";
import {
  createSession,
  deleteSession,
  getSession,
  getUserByUsername,
  touchSession
} from "./db.js";

const SESSION_COOKIE = "wah_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export const roles = {
  admin: [
    "clients:read",
    "clients:delete",
    "tasks:read",
    "tasks:send",
    "messages:read",
    "requests:read",
    "webhooks:manage",
    "users:manage"
  ],
  operator: [
    "clients:read",
    "tasks:read",
    "tasks:send",
    "messages:read",
    "requests:read"
  ],
  viewer: [
    "clients:read",
    "tasks:read",
    "messages:read"
  ]
};

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 310_000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || "").split("$");
  if (scheme !== "pbkdf2_sha256" || !salt || !expected) return false;
  const actual = hashPassword(password, salt).split("$")[2];
  return safeEqual(actual, expected);
}

export function requireWebSession(req, res, next) {
  const session = readSession(req);
  if (!session) {
    if (req.path.startsWith("/admin/api/")) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    return res.redirect("/login");
  }
  req.user = session.user;
  req.session = session;
  next();
}

export function getSessionFromCookieHeader(cookieHeader) {
  const token = getCookieFromHeader(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const session = getSession(token);
  if (!session || !session.user || new Date(session.expires_at).getTime() < Date.now()) {
    deleteSession(token);
    return null;
  }
  touchSession(token);
  return { ...session, user: publicUser(session.user) };
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "unauthenticated" });
    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}

export function hasPermission(user, permission) {
  return roles[user.role]?.includes(permission) || false;
}

export function loginUser(username, password, req) {
  const user = getUserByUsername(username);
  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    return null;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  createSession({
    token,
    userId: user.id,
    expiresAt,
    ip: req.ip,
    userAgent: req.header("user-agent")
  });
  return { token, user: publicUser(user), expiresAt };
}

export function logoutUser(req, res) {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) deleteSession(token);
  clearSessionCookie(res);
}

export function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    expires: new Date(expiresAt),
    path: "/"
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    enabled: Boolean(user.enabled),
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
    permissions: roles[user.role] || []
  };
}

function readSession(req) {
  return getSessionFromCookieHeader(req.header("cookie") || "");
}

function getCookie(req, name) {
  return getCookieFromHeader(req.header("cookie") || "", name);
}

function getCookieFromHeader(header, name) {
  const cookies = Object.fromEntries(String(header || "").split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
  return cookies[name] || "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
