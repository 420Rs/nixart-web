const crypto = require("node:crypto");
const { neon } = require("@neondatabase/serverless");

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const DEVICE_ID_RE = /^[a-f0-9]{24}$/;
let sqlClient;
let tablesReady;

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function secret() {
  const value = String(process.env.RVP_LICENSE_SECRET || process.env.SEPAY_API_KEY || "");
  if (Buffer.byteLength(value) < 32) throw new Error("RVP_LICENSE_SECRET or SEPAY_API_KEY must contain at least 32 bytes");
  return value;
}

function base32(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function accessCode(order) {
  const digest = crypto.createHmac("sha256", secret())
    .update(`${String(order.id)}:${String(order.course_id)}`)
    .digest()
    .subarray(0, 15);
  return base32(digest).match(/.{1,4}/g).join("-");
}

function codeHash(code) {
  return crypto.createHash("sha256").update(String(code || "").trim().toUpperCase()).digest("hex");
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2000 ? url.href : "";
  } catch { return ""; }
}

function courseRegistration(input) {
  const courseId = String(input.course_id || "").trim().toLowerCase();
  const title = String(input.title || "").trim();
  const downloadUrl = httpsUrl(input.download_url);
  const courseKey = Buffer.from(String(input.course_key || ""), "base64");
  const packageSha256 = String(input.package_sha256 || "").trim().toLowerCase();
  if (!ID_RE.test(courseId) || !title || title.length > 300 || !downloadUrl
      || courseKey.length !== 32 || !/^[a-f0-9]{64}$/.test(packageSha256)) {
    throw new Error("Invalid RVP course registration");
  }
  return { courseId, title, downloadUrl, courseKey: courseKey.toString("base64"), packageSha256 };
}

async function ensureRvpTables(sqlOverride) {
  if (!sqlOverride && tablesReady) return tablesReady;
  const sql = sqlOverride || db();
  const work = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS rvp_courses (
        course_id VARCHAR(80) PRIMARY KEY,
        title VARCHAR(300) NOT NULL,
        download_url TEXT NOT NULL,
        course_key VARCHAR(44) NOT NULL,
        package_sha256 VARCHAR(64) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS rvp_access_codes (
        code_hash VARCHAR(64) PRIMARY KEY,
        order_id UUID UNIQUE NOT NULL REFERENCES purchase_orders(id),
        course_id VARCHAR(80) NOT NULL REFERENCES rvp_courses(course_id),
        device_id VARCHAR(24),
        device_public_key TEXT,
        activated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
  })();
  if (!sqlOverride) tablesReady = work.catch(error => { tablesReady = null; throw error; });
  return work;
}

async function registerCourse(input, sqlOverride) {
  const course = courseRegistration(input);
  await ensureRvpTables(sqlOverride);
  const sql = sqlOverride || db();
  await sql`
    INSERT INTO rvp_courses (course_id, title, download_url, course_key, package_sha256)
    VALUES (${course.courseId}, ${course.title}, ${course.downloadUrl}, ${course.courseKey}, ${course.packageSha256})
    ON CONFLICT (course_id) DO UPDATE
    SET title = EXCLUDED.title, download_url = EXCLUDED.download_url,
        course_key = EXCLUDED.course_key, package_sha256 = EXCLUDED.package_sha256, updated_at = NOW()
  `;
  return { courseId: course.courseId, title: course.title, downloadUrl: course.downloadUrl, packageSha256: course.packageSha256 };
}

async function approveRvpOrder(order, sqlOverride) {
  await ensureRvpTables(sqlOverride);
  const sql = sqlOverride || db();
  const code = accessCode(order);
  const rows = await sql`
    WITH registered AS (
      SELECT course_id, download_url FROM rvp_courses WHERE course_id = ${String(order.course_id)}
    ), issued AS (
      INSERT INTO rvp_access_codes (code_hash, order_id, course_id)
      SELECT ${codeHash(code)}, ${String(order.id)}::uuid, course_id FROM registered
      ON CONFLICT (order_id) DO UPDATE SET code_hash = EXCLUDED.code_hash
      RETURNING course_id
    )
    UPDATE purchase_orders
    SET status = 'approved', paid_at = COALESCE(paid_at, NOW()), reviewed_at = NOW()
    WHERE id = ${String(order.id)}::uuid AND delivery_type = 'rvp' AND EXISTS (SELECT 1 FROM issued)
    RETURNING id
  `;
  if (!rows.length) throw new Error("RVP course is not registered or order cannot be approved");
  const courseRows = await sql`SELECT download_url FROM rvp_courses WHERE course_id = ${String(order.course_id)} LIMIT 1`;
  return { ...order, delivery_type: "rvp", access_code: code, rvp_download_url: String(courseRows[0]?.download_url || "") };
}

function pairing(input) {
  const deviceId = String(input.device_id || "").trim().toLowerCase();
  if (!DEVICE_ID_RE.test(deviceId)) throw new Error("Invalid device id");
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(input.pairing_code || ""), "base64url").toString("utf8")); }
  catch { throw new Error("Invalid pairing code"); }
  const publicKey = Buffer.from(String(parsed.PublicKey || ""), "base64");
  const derivedId = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 24);
  if (parsed.Version !== 1 || parsed.DeviceId !== deviceId || derivedId !== deviceId) throw new Error("Pairing code does not match device");
  const keyObject = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });
  if (keyObject.asymmetricKeyType !== "rsa") throw new Error("Unsupported device key");
  return { deviceId, publicKey, keyObject };
}

async function redeem(input, sqlOverride) {
  const device = pairing(input);
  const requestedCourse = String(input.course_id || "").trim().toLowerCase();
  if (requestedCourse && !ID_RE.test(requestedCourse)) throw new Error("Invalid course id");
  await ensureRvpTables(sqlOverride);
  const sql = sqlOverride || db();
  const claimed = await sql`
    UPDATE rvp_access_codes
    SET device_id = COALESCE(device_id, ${device.deviceId}),
        device_public_key = COALESCE(device_public_key, ${device.publicKey.toString("base64")}),
        activated_at = COALESCE(activated_at, NOW())
    WHERE code_hash = ${codeHash(input.code)}
      AND (device_id IS NULL OR device_id = ${device.deviceId})
      AND (${requestedCourse} = '' OR course_id = ${requestedCourse})
    RETURNING course_id
  `;
  if (!claimed.length) throw new Error("Mã không hợp lệ hoặc đã kích hoạt trên thiết bị khác.");
  const courses = await sql`
    SELECT course_id, title, download_url, course_key, package_sha256
    FROM rvp_courses WHERE course_id = ${claimed[0].course_id} LIMIT 1
  `;
  if (!courses.length) throw new Error("Khóa học RVP không còn tồn tại.");
  const course = courses[0];
  const wrapped = crypto.publicEncrypt({ key: device.keyObject, oaepHash: "sha256", padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(course.course_key, "base64"));
  return {
    course_id: String(course.course_id),
    title: String(course.title),
    download_url: String(course.download_url),
    wrapped_key: wrapped.toString("base64"),
    package_sha256: String(course.package_sha256)
  };
}

module.exports = { accessCode, approveRvpOrder, codeHash, courseRegistration, ensureRvpTables, pairing, redeem, registerCourse };
