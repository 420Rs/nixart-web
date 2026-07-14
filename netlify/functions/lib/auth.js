const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const COOKIE_NAME = "nix_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
let sqlClient;
let tablesReady;

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map(part => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    const key = part.slice(0, index).trim();
    try { return [key, decodeURIComponent(part.slice(index + 1).trim())]; }
    catch (_) { return [key, ""]; }
  }).filter(([key]) => key));
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function secureRequest(event) {
  const headers = event?.headers || {};
  const host = String(headers.host || headers.Host || "");
  const proto = String(headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "");
  return !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) && proto !== "http";
}

function cookie(name, value, event, maxAge, path = "/") {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(event) ? "; Secure" : ""}`;
}

function sessionCookie(token, event, maxAge = SESSION_SECONDS) {
  return cookie(COOKIE_NAME, token, event, maxAge);
}

async function ensureAuthTables() {
  if (tablesReady) return tablesReady;
  const sql = db();
  tablesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS app_users (
        id UUID PRIMARY KEY,
        email VARCHAR(254) UNIQUE,
        password_hash VARCHAR(128),
        password_salt VARCHAR(64),
        discord_id VARCHAR(32) UNIQUE,
        discord_username VARCHAR(100),
        discord_display_name VARCHAR(100),
        discord_avatar VARCHAR(300),
        failed_attempts INT NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        disabled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE app_users ALTER COLUMN email DROP NOT NULL`;
    await sql`ALTER TABLE app_users ALTER COLUMN password_hash DROP NOT NULL`;
    await sql`ALTER TABLE app_users ALTER COLUMN password_salt DROP NOT NULL`;
    await sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS discord_id VARCHAR(32)`;
    await sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS discord_username VARCHAR(100)`;
    await sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS discord_display_name VARCHAR(100)`;
    await sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS discord_avatar VARCHAR(300)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS app_users_discord_idx ON app_users (discord_id) WHERE discord_id IS NOT NULL`;
    await sql`
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash VARCHAR(64) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id)`;
  })().catch(error => {
    tablesReady = null;
    throw error;
  });
  return tablesReady;
}

async function createSession(userId) {
  await ensureAuthTables();
  const token = crypto.randomBytes(32).toString("hex");
  const sql = db();
  await sql`INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (${tokenHash(token)}, ${userId}, NOW() + INTERVAL '30 days')`;
  return token;
}

async function getAuthenticatedUser(event) {
  const token = parseCookies(event?.headers?.cookie || event?.headers?.Cookie)[COOKIE_NAME];
  if (!token) return null;
  try {
    await ensureAuthTables();
    const sql = db();
    const rows = await sql`
      SELECT u.id, u.email,
             u.discord_id AS "discordId",
             u.discord_username AS "username",
             u.discord_display_name AS "displayName",
             u.discord_avatar AS "avatarHash"
      FROM user_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash(token)} AND s.expires_at > NOW() AND u.disabled_at IS NULL
      LIMIT 1
    `;
    return rows[0] || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  cookie,
  createSession,
  db,
  ensureAuthTables,
  getAuthenticatedUser,
  parseCookies,
  sessionCookie,
  tokenHash
};
