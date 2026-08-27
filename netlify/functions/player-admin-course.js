const crypto = require("node:crypto");
const { registerCourse } = require("../../rvp-license");
const { ensureLearningTables } = require("../../learning");

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function authorized(event) {
  const expected = Buffer.from(String(process.env.RVP_ADMIN_TOKEN || process.env.ADMIN_PASSWORD || ""));
  const actual = Buffer.from(String(event.headers?.authorization || event.headers?.Authorization || "").replace(/^Bearer\s+/i, ""));
  return expected.length >= 32 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

exports.handler = async event => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!authorized(event)) return json(401, { error: "Unauthorized" });
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON" }); }
  try {
    await ensureLearningTables();
    return json(200, { ok: true, course: await registerCourse(body) });
  }
  catch (error) {
    console.error("RVP course registration error", error);
    return json(400, { error: String(error.message || "Registration failed") });
  }
};
