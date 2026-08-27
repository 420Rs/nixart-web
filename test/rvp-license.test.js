const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { accessCode, courseRegistration, pairing, redeem, reissueAccessCode } = require("../rvp-license");

function devicePairing() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ format: "der", type: "spki" });
  const deviceId = crypto.createHash("sha256").update(der).digest("hex").slice(0, 24);
  const code = Buffer.from(JSON.stringify({
    Version: 1, DeviceId: deviceId, PublicKey: der.toString("base64")
  })).toString("base64url");
  return { deviceId, code, privateKey };
}

test("RVP registration rejects malformed keys and non-HTTPS links", () => {
  assert.throws(() => courseRegistration({
    course_id: "course-a", title: "A", download_url: "http://example.com/a.rvp",
    course_key: Buffer.alloc(32).toString("base64"), package_sha256: "a".repeat(64)
  }), /Invalid RVP/);
  const valid = courseRegistration({
    course_id: "course-a", package_course_id: "package-random-1", title: "A", download_url: "https://example.com/a.rvp",
    course_key: Buffer.alloc(32).toString("base64"), package_sha256: "a".repeat(64)
  });
  assert.equal(valid.courseId, "course-a");
  assert.equal(valid.packageCourseId, "package-random-1");
});

test("one-time code is deterministic and a redeemed course key unwraps only on that device", async () => {
  const old = process.env.RVP_LICENSE_SECRET;
  process.env.RVP_LICENSE_SECRET = "test-secret-that-is-at-least-32-bytes-long";
  try {
    const order = { id: "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9", course_id: "course-a" };
    assert.equal(accessCode(order), accessCode(order));
    assert.match(accessCode(order), /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
    const device = devicePairing();
    assert.equal(pairing({ device_id: device.deviceId, pairing_code: device.code }).deviceId, device.deviceId);
    const courseKey = crypto.randomBytes(32);
    const sql = async (strings) => {
      const query = strings.join(" ");
      if (/UPDATE rvp_access_codes/.test(query)) return [{ course_id: "course-a" }];
      if (/SELECT course_id, package_course_id, title, download_url, course_key/.test(query)) return [{
        course_id: "course-a", package_course_id: "package-random-1", title: "Course A", download_url: "https://example.com/a.rvp",
        course_key: courseKey.toString("base64"), package_sha256: "a".repeat(64)
      }];
      return [];
    };
    const result = await redeem({ code: accessCode(order), device_id: device.deviceId, pairing_code: device.code }, sql);
    assert.equal(result.course_id, "package-random-1");
    const unwrapped = crypto.privateDecrypt({ key: device.privateKey, oaepHash: "sha256" }, Buffer.from(result.wrapped_key, "base64"));
    assert.deepEqual(unwrapped, courseKey);
  } finally {
    if (old === undefined) delete process.env.RVP_LICENSE_SECRET; else process.env.RVP_LICENSE_SECRET = old;
  }
});

test("local Discord delivery reissues the same code it sends", async () => {
  const old = process.env.RVP_LICENSE_SECRET;
  process.env.RVP_LICENSE_SECRET = "test-secret-that-is-at-least-32-bytes-long";
  try {
    const order = { id: "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9", course_id: "course-a" };
    let updatedHash = "";
    const sql = async (strings, ...values) => {
      if (/UPDATE rvp_access_codes/.test(strings.join(" "))) {
        updatedHash = values[0];
        return [{ order_id: order.id }];
      }
      return [];
    };
    const code = await reissueAccessCode(order, sql);
    assert.equal(code, accessCode(order));
    assert.equal(updatedHash.length, 64);
  } finally {
    if (old === undefined) delete process.env.RVP_LICENSE_SECRET; else process.env.RVP_LICENSE_SECRET = old;
  }
});
