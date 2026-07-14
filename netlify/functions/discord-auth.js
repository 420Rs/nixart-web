const crypto = require("crypto");
const {
  cookie,
  createSession,
  db,
  ensureAuthTables,
  parseCookies,
  sessionCookie
} = require("./lib/auth");

const STATE_COOKIE = "nix_oauth_state";

function redirect(location, cookieValue) {
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (cookieValue) headers["Set-Cookie"] = cookieValue;
  return { statusCode: 302, headers, body: "" };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
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

function baseUrl(event) {
  const configured = String(process.env.PUBLIC_BASE_URL || process.env.URL || "").replace(/\/$/, "");
  if (configured) return configured;
  const host = event.headers.host || event.headers.Host || "localhost:3000";
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? "http" : "https";
  return `${proto}://${host}`;
}

function redirectUri(event) {
  return process.env.DISCORD_REDIRECT_URI || `${baseUrl(event)}/api/discord-auth`;
}

function encodeState(returnTo) {
  return Buffer.from(JSON.stringify({ n: crypto.randomBytes(24).toString("hex"), r: returnTo })).toString("base64url");
}

function decodeState(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    return parsed?.n && parsed?.r ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function discordUser(code, event) {
  const clientId = String(process.env.DISCORD_CLIENT_ID || "");
  const clientSecret = String(process.env.DISCORD_CLIENT_SECRET || "");
  if (!clientId || !clientSecret) throw new Error("Discord OAuth is not configured");

  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(event) })
  });
  if (!tokenResponse.ok) throw new Error(`Discord token exchange failed (${tokenResponse.status})`);
  const token = await tokenResponse.json();

  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  if (!userResponse.ok) throw new Error(`Discord identity request failed (${userResponse.status})`);
  return userResponse.json();
}

async function saveDiscordUser(profile) {
  await ensureAuthTables();
  const sql = db();
  const discordId = String(profile.id || "");
  if (!/^\d{15,25}$/.test(discordId)) throw new Error("Invalid Discord user id");

  let rows = await sql`SELECT id FROM app_users WHERE discord_id = ${discordId} LIMIT 1`;
  let userId = rows[0]?.id;
  if (!userId) {
    userId = crypto.randomUUID();
    const inserted = await sql`
      INSERT INTO app_users (id, discord_id, discord_username, discord_display_name, discord_avatar)
      VALUES (${userId}, ${discordId}, ${String(profile.username || "").slice(0, 100)}, ${String(profile.global_name || profile.username || "").slice(0, 100)}, ${String(profile.avatar || "").slice(0, 300)})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (!inserted.length) {
      rows = await sql`SELECT id FROM app_users WHERE discord_id = ${discordId} LIMIT 1`;
      userId = rows[0]?.id;
    }
  }
  if (!userId) throw new Error("Could not save Discord user");
  await sql`
    UPDATE app_users
    SET discord_username = ${String(profile.username || "").slice(0, 100)},
        discord_display_name = ${String(profile.global_name || profile.username || "").slice(0, 100)},
        discord_avatar = ${String(profile.avatar || "").slice(0, 300)}
    WHERE id = ${userId}
  `;
  return userId;
}

exports.safeReturnTo = safeReturnTo;

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Phương thức không được hỗ trợ" });
  const params = event.queryStringParameters || {};

  if (params.error) {
    const deniedState = String(params.state || "");
    const deniedExpected = parseCookies(event.headers.cookie || event.headers.Cookie)[STATE_COOKIE];
    const denied = deniedState === deniedExpected ? decodeState(deniedState) : null;
    return redirect(returnWithError(denied?.r || "/learn", "denied"));
  }

  if (!params.code) {
    const clientId = String(process.env.DISCORD_CLIENT_ID || "");
    if (!clientId) return json(503, { error: "Chưa cấu hình DISCORD_CLIENT_ID" });
    const state = encodeState(safeReturnTo(params.returnTo));
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "identify",
      state,
      redirect_uri: redirectUri(event)
    });
    return redirect(authorize.toString(), cookie(STATE_COOKIE, state, event, 600));
  }

  const state = String(params.state || "");
  const expected = parseCookies(event.headers.cookie || event.headers.Cookie)[STATE_COOKIE];
  const decoded = decodeState(state);
  if (!decoded || !expected || state !== expected) return redirect("/learn?auth_error=state");

  try {
    const profile = await discordUser(String(params.code), event);
    const session = await createSession(await saveDiscordUser(profile));
    return redirect(safeReturnTo(decoded.r), sessionCookie(session, event));
  } catch (error) {
    console.error("discord auth error", error);
    return redirect(returnWithError(decoded.r, "discord"));
  }
};
