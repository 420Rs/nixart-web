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

function validSubject(value) {
  const subject = String(value || "");
  return /^\d{15,25}$/.test(subject)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject);
}

function issueMediaToken({ userId, discordId, courseId, lessonId, ttlSeconds = 3600 }) {
  const subject = String(userId || discordId || "");
  if (!validSubject(subject) || !ID_RE.test(courseId) || !ID_RE.test(lessonId)) {
    throw new Error("Invalid media token scope");
  }
  const body = Buffer.from(JSON.stringify({
    v: 2,
    sub: subject,
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
    if (![1, 2].includes(payload.v) || !validSubject(payload.sub) || payload.exp <= nowSeconds || payload.course !== courseId || payload.lesson !== lessonId) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

module.exports = { COOKIE_NAME, issueMediaToken, verifyMediaToken };
