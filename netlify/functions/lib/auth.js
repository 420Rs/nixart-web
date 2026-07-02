const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);
const COOKIE_NAME = "nix_session";

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map(part => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

async function getAuthenticatedUser(event) {
  const token = parseCookies(event.headers.cookie || event.headers.Cookie)[COOKIE_NAME];
  if (!token) return null;
  const crypto = require("crypto");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    const rows = await sql`
      SELECT u.id, u.email
      FROM user_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash} AND s.expires_at > NOW() AND u.disabled_at IS NULL
      LIMIT 1
    `;
    return rows[0] || null;
  } catch (_) {
    return null;
  }
}

module.exports = { COOKIE_NAME, getAuthenticatedUser };
