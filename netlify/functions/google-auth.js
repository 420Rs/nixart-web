const crypto = require("crypto");
const { google } = require("googleapis");
const {
  cookie,
  createSession,
  db,
  ensureAuthTables,
  parseCookies,
  sessionCookie
} = require("./lib/auth");
const { claimUserEntitlements } = require("../../learning");

const STATE_COOKIE = "nix_google_oauth_state";
const STATE_SECONDS = 10 * 60;
const GOOGLE_SCOPES = Object.freeze(["openid", "email", "profile"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

function redirect(location, cookieValues = []) {
  const values = cookieValues.filter(Boolean);
  const result = { statusCode: 302, headers: { Location: location, "Cache-Control": "no-store" }, body: "" };
  if (values.length === 1) result.headers["Set-Cookie"] = values[0];
  if (values.length > 1) result.multiValueHeaders = { "Set-Cookie": values };
  return result;
}

function safeReturnTo(value) {
  const raw = String(value || "/learn").slice(0, 1000);
  try {
    const target = new URL(raw, "http://nixart.local");
    if (target.origin !== "http://nixart.local" || target.pathname !== "/learn") return "/learn";
    return `${target.pathname}${target.search}`;
  } catch (_) {
    return "/learn";
  }
}

function returnWithError(returnTo, code) {
  const target = new URL(safeReturnTo(returnTo), "http://localhost");
  target.searchParams.set("auth_error", code);
  return `${target.pathname}${target.search}`;
}

function encodeState(returnTo, now = Date.now()) {
  return Buffer.from(JSON.stringify({
    s: crypto.randomBytes(24).toString("hex"),
    n: crypto.randomBytes(24).toString("hex"),
    r: safeReturnTo(returnTo),
    t: now
  })).toString("base64url");
}

function decodeState(value, now = Date.now()) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (!/^[a-f0-9]{48}$/.test(String(parsed?.s || "")) || !/^[a-f0-9]{48}$/.test(String(parsed?.n || ""))) return null;
    if (!Number.isSafeInteger(parsed.t) || parsed.t > now + 60_000 || parsed.t < now - STATE_SECONDS * 1000) return null;
    if (typeof parsed.r !== "string" || safeReturnTo(parsed.r) !== parsed.r) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const atom = "[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}";
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const local = email.split("@", 1)[0];
  return email.length <= 254 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && new RegExp(`^${atom}@${label}(?:\\.${label})+$`, "i").test(email) ? email : "";
}

function safePicture(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 500 ? url.href : "";
  } catch (_) {
    return "";
  }
}

function validateGoogleClaims(payload, expectedNonce, clientId, nowSeconds = Math.floor(Date.now() / 1000)) {
  const issuer = String(payload?.iss || "");
  const sub = String(payload?.sub || "");
  const email = normalizeEmail(payload?.email);
  if (!["accounts.google.com", "https://accounts.google.com"].includes(issuer)) throw new Error("Invalid Google token issuer");
  if (!clientId || payload?.aud !== clientId) throw new Error("Invalid Google token audience");
  if (!Number.isSafeInteger(payload?.exp) || payload.exp <= nowSeconds) throw new Error("Expired Google token");
  if (!expectedNonce || !safeEqual(payload?.nonce, expectedNonce)) throw new Error("Invalid Google token nonce");
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(sub)) throw new Error("Invalid Google subject");
  if (payload?.email_verified !== true || !email) throw new Error("Google email is not verified");
  const name = String(payload?.name || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100);
  const domain = email.split("@")[1];
  const hostedDomain = String(payload?.hd || "").trim().toLowerCase();
  const emailAuthoritative = domain === "gmail.com" || (Boolean(hostedDomain) && hostedDomain === domain);
  return { sub, email, name: name || email, picture: safePicture(payload?.picture), emailAuthoritative };
}

function validatedRedirectUri(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch (_) { throw new Error("GOOGLE_OAUTH_REDIRECT_URI is invalid"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.username || url.password || url.search || url.hash || url.pathname !== "/api/google-auth") {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must be the Google callback URL");
  }
  return url.toString();
}

function configuration() {
  const clientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret || !process.env.GOOGLE_OAUTH_REDIRECT_URI) throw new Error("Google OAuth is not configured");
  return { clientId, clientSecret, redirectUri: validatedRedirectUri(process.env.GOOGLE_OAUTH_REDIRECT_URI) };
}

function accountConflict() {
  return Object.assign(new Error("Verified email belongs to another account"), { code: "GOOGLE_ACCOUNT_CONFLICT" });
}

async function updateGoogleUser(sql, userId, profile) {
  const owner = await sql`SELECT id FROM app_users WHERE LOWER(email) = ${profile.email} LIMIT 1`;
  if (owner[0] && String(owner[0].id) !== String(userId)) throw accountConflict();
  const rows = await sql`
    UPDATE app_users
    SET email = ${profile.email}, google_display_name = ${profile.name}, google_avatar = ${profile.picture},
        email_verified_at = NOW(),
        email_authoritative_at = CASE WHEN ${profile.emailAuthoritative} THEN NOW() ELSE NULL END
    WHERE id = ${userId} AND google_sub = ${profile.sub}
    RETURNING id
  `;
  if (!rows[0]?.id) throw new Error("Could not update Google user");
  return rows[0].id;
}

async function saveGoogleUser(profile) {
  await ensureAuthTables();
  const sql = db();
  let rows = await sql`SELECT id FROM app_users WHERE google_sub = ${profile.sub} LIMIT 1`;
  if (rows[0]?.id) return updateGoogleUser(sql, rows[0].id, profile);

  const emailOwner = await sql`
    SELECT id, discord_id, google_sub
    FROM app_users
    WHERE LOWER(email) = ${profile.email} AND disabled_at IS NULL
    LIMIT 1
  `;
  if (emailOwner[0]) {
    // Upgrade an old email-only account after Google has proved control of that exact mailbox.
    if (!profile.emailAuthoritative || emailOwner[0].discord_id || emailOwner[0].google_sub) throw accountConflict();
    const linked = await sql`
      WITH linked_user AS (
        UPDATE app_users
        SET google_sub = ${profile.sub}, google_display_name = ${profile.name},
            google_avatar = ${profile.picture}, email_verified_at = NOW(),
            email_authoritative_at = CASE WHEN ${profile.emailAuthoritative} THEN NOW() ELSE NULL END
        WHERE id = ${emailOwner[0].id} AND discord_id IS NULL AND google_sub IS NULL
        RETURNING id
      ), revoked_sessions AS (
        DELETE FROM user_sessions
        WHERE user_id IN (SELECT id FROM linked_user)
      )
      SELECT id FROM linked_user
    `;
    if (linked[0]?.id) return linked[0].id;
    rows = await sql`SELECT id FROM app_users WHERE google_sub = ${profile.sub} LIMIT 1`;
    if (rows[0]?.id) return updateGoogleUser(sql, rows[0].id, profile);
    throw accountConflict();
  }

  const userId = crypto.randomUUID();
  const inserted = await sql`
    INSERT INTO app_users (id, email, google_sub, google_display_name, google_avatar, email_verified_at, email_authoritative_at)
    VALUES (${userId}, ${profile.email}, ${profile.sub}, ${profile.name}, ${profile.picture}, NOW(),
            CASE WHEN ${profile.emailAuthoritative} THEN NOW() ELSE NULL END)
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (inserted[0]?.id) return inserted[0].id;

  // A concurrent first login for the same Google account may have won the insert.
  rows = await sql`SELECT id FROM app_users WHERE google_sub = ${profile.sub} LIMIT 1`;
  if (rows[0]?.id) return updateGoogleUser(sql, rows[0].id, profile);
  throw accountConflict();
}

async function exchangeGoogleCode(code, state) {
  const config = configuration();
  const client = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
  const { tokens } = await client.getToken(String(code));
  if (!tokens.id_token) throw new Error("Google did not return an ID token");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
  return validateGoogleClaims(ticket.getPayload(), state.n, config.clientId);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Phương thức không được hỗ trợ" });
  const params = event.queryStringParameters || {};
  const headers = event.headers || {};
  const clearState = cookie(STATE_COOKIE, "", event, 0);

  if (!params.code && !params.state && !params.error) {
    try {
      const config = configuration();
      const state = encodeState(params.returnTo);
      const decoded = decodeState(state);
      const client = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
      const authorize = client.generateAuthUrl({
        scope: GOOGLE_SCOPES,
        state,
        nonce: decoded.n,
        prompt: "select_account"
      });
      return redirect(authorize, [cookie(STATE_COOKIE, state, event, STATE_SECONDS)]);
    } catch (error) {
      console.error("google auth configuration error", error);
      return json(503, { error: "Chưa cấu hình đăng nhập Google" });
    }
  }

  const suppliedState = String(params.state || "");
  const expectedState = parseCookies(headers.cookie || headers.Cookie)[STATE_COOKIE];
  const state = expectedState && safeEqual(suppliedState, expectedState) ? decodeState(suppliedState) : null;
  if (!state) return redirect("/learn?auth_error=state", [clearState]);
  if (params.error) return redirect(returnWithError(state.r, "denied"), [clearState]);
  if (!params.code || String(params.code).length > 4096) return redirect(returnWithError(state.r, "google"), [clearState]);

  try {
    const profile = await exchangeGoogleCode(String(params.code), state);
    const userId = await saveGoogleUser(profile);
    await claimUserEntitlements({
      id: userId,
      email: profile.email,
      emailVerified: true,
      emailAuthoritative: profile.emailAuthoritative
    });
    const session = await createSession(userId);
    return redirect(safeReturnTo(state.r), [clearState, sessionCookie(session, event)]);
  } catch (error) {
    console.error("google auth error", error);
    const code = error.code === "GOOGLE_ACCOUNT_CONFLICT" ? "account" : "google";
    return redirect(returnWithError(state.r, code), [clearState]);
  }
};

exports.GOOGLE_SCOPES = GOOGLE_SCOPES;
exports.decodeState = decodeState;
exports.normalizeEmail = normalizeEmail;
exports.safeReturnTo = safeReturnTo;
exports.validateGoogleClaims = validateGoogleClaims;
exports.validatedRedirectUri = validatedRedirectUri;
