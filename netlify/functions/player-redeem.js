const { redeem } = require("../../rvp-license");
const { ensureLearningTables } = require("../../learning");

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "JSON không hợp lệ." }); }
  try {
    await ensureLearningTables();
    return json(200, await redeem(body));
  }
  catch (error) {
    const message = String(error.message || "Kích hoạt thất bại.");
    const status = /đã kích hoạt|không hợp lệ/i.test(message) ? 409 : /Invalid|Pairing/i.test(message) ? 400 : 500;
    if (status === 500) console.error("RVP redeem error", error);
    return json(status, { error: message });
  }
};
