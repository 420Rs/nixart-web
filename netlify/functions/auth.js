const crypto = require("crypto");
const { promisify } = require("util");
const { neon } = require("@neondatabase/serverless");
const { COOKIE_NAME, getAuthenticatedUser } = require("./lib/auth");

const sql = neon(process.env.DATABASE_URL);
const scrypt = promisify(crypto.scrypt);
const SESSION_SECONDS = 30 * 24 * 60 * 60;

function response(statusCode, body, cookie) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return { statusCode, headers, body: JSON.stringify(body) };
}

function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function tokenHash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

async function passwordHash(password, salt) {
  return (await scrypt(password, salt, 64)).toString("hex");
}

async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY,
      email VARCHAR(254) UNIQUE NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      password_salt VARCHAR(64) NOT NULL,
      failed_attempts INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash VARCHAR(64) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id)`;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await sql`INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (${tokenHash(token)}, ${userId}, NOW() + INTERVAL '30 days')`;
  return token;
}

exports.handler = async (event) => {
  try {
    await ensureTables();

    if (event.httpMethod === "GET") {
      const user = await getAuthenticatedUser(event);
      return response(200, { user });
    }

    if (event.httpMethod !== "POST") return response(405, { error: "Phuong thuc khong duoc ho tro" });
    let payload;
    try { payload = JSON.parse(event.body || "{}"); } catch (_) { return response(400, { error: "Du lieu khong hop le" }); }

    if (payload.action === "logout") {
      const cookie = String(event.headers.cookie || "");
      const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
      if (match) await sql`DELETE FROM user_sessions WHERE token_hash = ${tokenHash(decodeURIComponent(match[1]))}`;
      return response(200, { ok: true }, sessionCookie("", 0));
    }

    const email = cleanEmail(payload.email);
    const password = String(payload.password || "");
    if (!validEmail(email) || password.length < 8 || password.length > 128) {
      return response(400, { error: "Email khong hop le hoac mat khau duoi 8 ky tu" });
    }

    if (payload.action === "register") {
      const existing = await sql`SELECT id FROM app_users WHERE email = ${email} LIMIT 1`;
      if (existing.length) return response(409, { error: "Email nay da co tai khoan" });
      const id = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString("hex");
      await sql`INSERT INTO app_users (id, email, password_hash, password_salt) VALUES (${id}, ${email}, ${await passwordHash(password, salt)}, ${salt})`;
      const token = await createSession(id);
      return response(201, { user: { id, email } }, sessionCookie(token));
    }

    if (payload.action === "login") {
      const rows = await sql`SELECT id, email, password_hash, password_salt, failed_attempts, locked_until FROM app_users WHERE email = ${email} LIMIT 1`;
      const user = rows[0];
      if (!user || (user.locked_until && new Date(user.locked_until) > new Date())) return response(401, { error: "Email hoac mat khau khong dung" });
      const candidate = await passwordHash(password, user.password_salt);
      const valid = crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.password_hash, "hex"));
      if (!valid) {
        await sql`UPDATE app_users SET failed_attempts = failed_attempts + 1, locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END WHERE id = ${user.id}`;
        return response(401, { error: "Email hoac mat khau khong dung" });
      }
      await sql`UPDATE app_users SET failed_attempts = 0, locked_until = NULL WHERE id = ${user.id}`;
      const token = await createSession(user.id);
      return response(200, { user: { id: user.id, email: user.email } }, sessionCookie(token));
    }

    return response(400, { error: "Hanh dong khong hop le" });
  } catch (error) {
    console.error("auth error", error);
    return response(500, { error: "Khong xu ly duoc tai khoan luc nay" });
  }
};
