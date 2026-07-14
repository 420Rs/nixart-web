const {
  COOKIE_NAME,
  db,
  ensureAuthTables,
  getAuthenticatedUser,
  parseCookies,
  sessionCookie,
  tokenHash
} = require("./lib/auth");

function response(statusCode, body, cookieValue) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (cookieValue) headers["Set-Cookie"] = cookieValue;
  return { statusCode, headers, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      return response(200, { user: await getAuthenticatedUser(event) });
    }

    if (event.httpMethod !== "POST") {
      return response(405, { error: "Phương thức không được hỗ trợ" });
    }

    let payload;
    try { payload = JSON.parse(event.body || "{}"); }
    catch (_) { return response(400, { error: "Dữ liệu không hợp lệ" }); }

    if (payload.action === "register" || payload.action === "login") {
      return response(410, { error: "Đăng nhập bằng email và mật khẩu đã ngừng hoạt động. Hãy dùng Discord." });
    }

    if (payload.action !== "logout") {
      return response(400, { error: "Hành động không hợp lệ" });
    }

    const headers = event.headers || {};
    const token = parseCookies(headers.cookie || headers.Cookie)[COOKIE_NAME];
    if (token) {
      await ensureAuthTables();
      const sql = db();
      await sql`DELETE FROM user_sessions WHERE token_hash = ${tokenHash(token)}`;
    }
    return response(200, { ok: true }, sessionCookie("", event, 0));
  } catch (error) {
    console.error("auth error", error);
    return response(500, { error: "Không xử lý được tài khoản lúc này" });
  }
};
