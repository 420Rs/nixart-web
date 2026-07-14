const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HLS_SIGNING_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";

const { canAccessCourse, cleanId, isCourseContentReady, isCourseSaleReady, isForumCourseSaleReady } = require("../learning");
const { issueMediaToken, verifyMediaToken } = require("../netlify/functions/lib/media-token");

test("media token is scoped to one lesson and expires", () => {
  const token = issueMediaToken({ discordId: "123456789012345678", courseId: "course-a", lessonId: "lesson-1" });
  assert.equal(verifyMediaToken(token, "course-a", "lesson-1").sub, "123456789012345678");
  assert.equal(verifyMediaToken(token, "course-a", "lesson-2"), null);
  assert.equal(verifyMediaToken(`${token}x`, "course-a", "lesson-1"), null);
  assert.equal(verifyMediaToken(token, "course-a", "lesson-1", Math.floor(Date.now() / 1000) + 3601), null);
});

test("individual, basic and full access follow catalog tier", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const basicCourse = { id: "basic-course", planTier: "basic" };
  const fullCourse = { id: "full-course", planTier: "full" };

  assert.equal(canAccessCourse([{ access_scope: "course", course_id: "full-course", access_expires_at: null }], fullCourse), true);
  assert.equal(canAccessCourse([{ access_scope: "basic", course_id: "plan:basic", access_expires_at: future }], basicCourse), true);
  assert.equal(canAccessCourse([{ access_scope: "basic", course_id: "plan:basic", access_expires_at: future }], fullCourse), false);
  assert.equal(canAccessCourse([{ access_scope: "full", course_id: "plan:full", access_expires_at: future }], fullCourse), true);
  assert.equal(canAccessCourse([{ access_scope: "full", course_id: "plan:full", access_expires_at: past }], basicCourse), false);
  assert.equal(cleanId("../secret"), "");
  assert.equal(isCourseContentReady({ published: true, rightsVerified: false }), false);
  assert.equal(isCourseContentReady({ published: true, rightsVerified: true }), true);
  assert.equal(isCourseSaleReady({ published: true, rightsVerified: false, price: 50000 }), false);
  assert.equal(isCourseSaleReady({ published: true, rightsVerified: true, price: 50000 }), true);
  assert.equal(isForumCourseSaleReady({ forumVisible: false, published: true, rightsVerified: true, price: 50000 }), false);
  assert.equal(isForumCourseSaleReady({ forumVisible: true, published: true, rightsVerified: true, price: 50000 }), true);
});

test("SePay webhook fails closed without an API key", async () => {
  const previous = process.env.SEPAY_API_KEY;
  delete process.env.SEPAY_API_KEY;
  const { handler } = require("../netlify/functions/sepay");
  const response = await handler({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(response.statusCode, 401);
  if (previous) process.env.SEPAY_API_KEY = previous;
});

test("legacy website checkout is disabled", async () => {
  const { handler } = require("../netlify/functions/orders");
  const response = await handler({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(response.statusCode, 410);
});

test("Discord OAuth return path cannot leave the learning page", () => {
  const { safeReturnTo } = require("../netlify/functions/discord-auth");
  assert.equal(safeReturnTo("/learn?course=a&lesson=b"), "/learn?course=a&lesson=b");
  assert.equal(safeReturnTo("/\\evil.example/path"), "/learn");
  assert.equal(safeReturnTo("//evil.example/path"), "/learn");
  assert.equal(safeReturnTo("/admin"), "/learn");
});

test("media server requires a scoped cookie and supports byte ranges", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nixart-media-"));
  const lessonDir = path.join(root, "course-a", "lesson-1");
  fs.mkdirSync(lessonDir, { recursive: true });
  fs.writeFileSync(path.join(lessonDir, "seg_00000.ts"), "0123456789");
  process.env.MEDIA_ROOT = root;
  const { server } = require("../server");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}/media/course-a/lesson-1/seg_00000.ts`;
  assert.equal((await fetch(base)).status, 403);

  const token = issueMediaToken({ discordId: "123456789012345678", courseId: "course-a", lessonId: "lesson-1" });
  const response = await fetch(base, { headers: { Cookie: `nix_media=${token}`, Range: "bytes=-4" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 6-9/10");
  assert.equal(await response.text(), "6789");
});
