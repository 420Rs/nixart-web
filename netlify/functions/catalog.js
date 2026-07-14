const { publicCatalog } = require("../../learning");

exports.handler = async (event) => ({
  statusCode: event.httpMethod === "GET" ? 200 : 405,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" },
  body: JSON.stringify(event.httpMethod === "GET" ? publicCatalog() : { error: "Phương thức không được hỗ trợ" })
});
