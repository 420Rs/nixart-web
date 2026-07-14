const { publicCatalog } = require("../../learning");

const WEB_ORIGINS = new Set(["https://nixart.io.vn", "https://www.nixart.io.vn"]);

exports.handler = async (event) => {
  const origin = String(event.headers?.origin || event.headers?.Origin || "");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=15, stale-while-revalidate=30",
    Vary: "Origin",
  };
  if (WEB_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" }, body: "" };
  }
  return {
    statusCode: event.httpMethod === "GET" ? 200 : 405,
    headers,
    body: JSON.stringify(event.httpMethod === "GET" ? publicCatalog() : { error: "Phương thức không được hỗ trợ" }),
  };
};
