const crypto = require("crypto");
const { ID_RE } = require("../../../learning");

const COOKIE_NAME = "nix_media";

function secret() {
  const value = String(process.env.HLS_SIGNING_SECRET || "");
  if (value.length < 32) throw new Error("HLS_SIGNING_SECRET must contain at least 32 characters");
  return value;
}

function signature(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function issueMediaToken({ discordId, courseId, lessonId, ttlSeconds = 3600 }) {
  if (!/^\d{15,25}$/.test(String(discordId || "")) || !ID_RE.test(courseId) || !ID_RE.test(lessonId)) {
    throw new Error("Invalid media token scope");
  }
  const body = Buffer.from(JSON.stringify({
    v: 1,
    sub: String(discordId),
    course: courseId,
    lesson: lessonId,
    exp: Math.floor(Date.now() / 1000) + Math.max(60, Math.min(3600, Number(ttlSeconds) || 3600))
  })).toString("base64url");
  return `${body}.${signature(body)}`;
}

function verifyMediaToken(token, courseId, lessonId, nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    const [body, supplied, extra] = String(token || "").split(".");
    if (!body || !supplied || extra) return null;
    const expected = signature(body);
    const suppliedBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.v !== 1 || payload.exp <= nowSeconds || payload.course !== courseId || payload.lesson !== lessonId) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = { COOKIE_NAME, issueMediaToken, verifyMediaToken };
