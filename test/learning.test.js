const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HLS_SIGNING_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";

const {
  canAccessCourse, cleanId, courseDeliveryMode, driveFolderId, effectiveDeliveryMode, escapeDiscordMarkdown, getCatalog, googleEmail,
  hasPublishedLesson, isCourseContentReady, isCourseListed, isCourseSaleReady, isDriveCourseReady,
  isForumCourseSaleReady, publicCatalog
} = require("../learning");
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
  const ready = {
    published: true, rightsVerified: true, deliveryMode: "STREAM", streamAvailable: true, saleEnabled: true,
    lessons: [{ id: "lesson-1", title: "Bài 1", published: true }]
  };
  assert.equal(isCourseListed({ ...ready, streamAvailable: false }), true);
  assert.equal(isCourseContentReady({ ...ready, streamAvailable: false }), false);
  assert.equal(isCourseContentReady({ ...ready, lessons: [] }), false);
  assert.equal(isCourseContentReady(ready), true);
  assert.equal(hasPublishedLesson(ready), true);
  assert.equal(isCourseSaleReady({ published: true, rightsVerified: false, price: 50000 }), false);
  assert.equal(isCourseSaleReady({ ...ready, streamAvailable: false, price: 50000 }), false);
  assert.equal(isCourseSaleReady({ ...ready, saleEnabled: false, price: 50000 }), false);
  assert.equal(isCourseSaleReady({ ...ready, price: 50000 }), true);
  assert.equal(isForumCourseSaleReady({ forumVisible: false, published: true, rightsVerified: true, price: 50000 }), false);
  assert.equal(isForumCourseSaleReady({ ...ready, forumVisible: true, price: 50000 }), true);

  const drive = {
    published: true, rightsVerified: true, deliveryMode: "DRIVE", streamAvailable: false, saleEnabled: true,
    driveFolderId: "1AbCdEfGhIjKlMnOpQrStUvWxYz", price: 200000, lessons: []
  };
  assert.equal(isDriveCourseReady(drive), true);
  assert.equal(isCourseContentReady(drive), false);
  assert.equal(isCourseSaleReady(drive), true);
  assert.equal(effectiveDeliveryMode(drive), "DRIVE");
  assert.equal(isCourseSaleReady({ ...drive, driveFolderId: "" }), false);
  assert.equal(courseDeliveryMode({ streamAvailable: true }), "STREAM");
  assert.equal(courseDeliveryMode({ streamAvailable: false }), "NON-STREAM");
  assert.equal(driveFolderId("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz?usp=sharing"), "1AbCdEfGhIjKlMnOpQrStUvWxYz");
  assert.equal(driveFolderId("https://evil.example/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz"), "");
  assert.equal(googleEmail(" User@Example.COM "), "user@example.com");
  assert.equal(googleEmail("not-an-email"), "");
  assert.equal(googleEmail(".user@example.com"), "");
  assert.equal(googleEmail("user..name@example.com"), "");
  assert.equal(googleEmail("user\u202E@example.com"), "");
  assert.equal(escapeDiscordMarkdown("a_b*`c|"), "a\\_b\\*\\`c\\|");
  assert.equal(escapeDiscordMarkdown("[duyệt](https://evil.example)"), "\\[duyệt\\]\\(https://evil.example\\)");
});

test("catalog reloads only complete JSON and public output uses an allowlist", () => {
  const catalogPath = path.resolve(__dirname, "..", "content", "catalog.json");
  const deliveryPath = path.resolve(__dirname, "..", "content", "delivery.private.json");
  const readFileSync = fs.readFileSync;
  const statSync = fs.statSync;
  let version = 1;
  let changeDuringRead = false;
  let source = JSON.stringify({
    name: "NIXART test",
    tagline: "test",
    discordUrl: "https://user:pass@discord.gg/test",
    plans: [{
      id: "basic", title: "Basic", price: 200000, durationDays: 30, description: "test",
      features: ["one"], published: true, adminNote: "hidden"
    }],
    courses: [{
      id: "course-a", title: "Alpha", description: "test", price: 50000, planTier: "basic",
      deliveryMode: "STREAM", streamAvailable: true, saleEnabled: true,
      imageUrl: "  https://cdn.example.test/image.png  ", previewUrl: "https://cdn.example.test/preview.mp4",
      published: true, rightsVerified: true, forumVisible: true, internalPath: "hidden",
      lessons: [{ id: "lesson-1", title: "Lesson", duration: "10:00", published: true, mediaPath: "hidden" }]
    }]
  });
  let deliverySource = JSON.stringify({ driveFolders: {} });

  fs.statSync = function (file, ...args) {
    if (path.resolve(String(file)) !== catalogPath) return statSync.call(this, file, ...args);
    return { size: Buffer.byteLength(source), mtimeMs: version };
  };
  fs.readFileSync = function (file, ...args) {
    const resolved = path.resolve(String(file));
    if (resolved === deliveryPath) return args[0] ? deliverySource : Buffer.from(deliverySource);
    if (resolved !== catalogPath) return readFileSync.call(this, file, ...args);
    const snapshot = Buffer.from(source);
    if (changeDuringRead) {
      version += 1;
      changeDuringRead = false;
    }
    return snapshot;
  };

  try {
    assert.equal(getCatalog().courses[0].title, "Alpha");
    const exposed = publicCatalog();
    assert.equal(exposed.discordUrl, "");
    assert.equal(exposed.courses[0].imageUrl, "https://cdn.example.test/image.png");
    assert.equal(exposed.courses[0].previewUrl, "https://cdn.example.test/preview.mp4");
    assert.equal(exposed.courses[0].deliveryMode, "STREAM");
    assert.equal(exposed.courses[0].streamAvailable, true);
    assert.equal(exposed.courses[0].saleEnabled, true);
    assert.equal("internalPath" in exposed.courses[0], false);
    assert.equal("rightsVerified" in exposed.courses[0], false);
    assert.equal("mediaPath" in exposed.courses[0].lessons[0], false);
    assert.equal("adminNote" in exposed.plans[0], false);
    assert.equal("published" in exposed.plans[0], false);

    source = source.replace('"deliveryMode":"STREAM"', '"deliveryMode":"NON-STREAM"').replace('"streamAvailable":true', '"streamAvailable":false');
    version += 1;
    const nonStream = publicCatalog();
    assert.equal(nonStream.courses.length, 1);
    assert.equal(nonStream.courses[0].streamAvailable, false);
    assert.equal(nonStream.courses[0].saleEnabled, false);
    source = source.replace('"deliveryMode":"NON-STREAM"', '"deliveryMode":"STREAM"').replace('"streamAvailable":false', '"streamAvailable":true');
    version += 1;

    source = source.replace('"published":true,"mediaPath":"hidden"', '"published":false,"mediaPath":"hidden"');
    version += 1;
    const noPublishedLesson = publicCatalog();
    assert.equal(noPublishedLesson.courses[0].streamAvailable, false);
    assert.equal(noPublishedLesson.courses[0].saleEnabled, false);
    source = source.replace('"published":false,"mediaPath":"hidden"', '"published":true,"mediaPath":"hidden"');
    version += 1;

    const driveCatalog = JSON.parse(source);
    Object.assign(driveCatalog.courses[0], {
      deliveryMode: "DRIVE", streamAvailable: false, lessons: []
    });
    deliverySource = JSON.stringify({ driveFolders: { "course-a": "1AbCdEfGhIjKlMnOpQrStUvWxYz" } });
    source = JSON.stringify(driveCatalog);
    version += 1;
    const driveExposed = publicCatalog();
    assert.equal(driveExposed.courses[0].deliveryMode, "DRIVE");
    assert.equal(driveExposed.courses[0].saleEnabled, true);
    assert.deepEqual(driveExposed.courses[0].lessons, []);
    assert.equal("driveFolderId" in driveExposed.courses[0], false);

    Object.assign(driveCatalog.courses[0], {
      deliveryMode: "STREAM", streamAvailable: true,
      lessons: [{ id: "lesson-1", title: "Lesson", duration: "10:00", published: true, mediaPath: "hidden" }]
    });
    deliverySource = JSON.stringify({ driveFolders: {} });
    source = JSON.stringify(driveCatalog);
    version += 1;

    source = source.replace('"Alpha"', '"Bravo"');
    version += 1;
    changeDuringRead = true;
    assert.equal(getCatalog().courses[0].title, "Bravo");

    source = "{";
    version += 1;
    assert.deepEqual(getCatalog().courses, []);
    source = JSON.stringify({ plans: [], courses: "invalid" });
    version += 1;
    assert.deepEqual(getCatalog().courses, []);

    source = JSON.stringify({
      plans: [],
      courses: [{
        id: "encoded-url", title: "URL", description: "", price: 0, planTier: "full",
        published: true, forumVisible: true, rightsVerified: true, deliveryMode: "STREAM",
        streamAvailable: true, saleEnabled: false,
        imageUrl: `https://example.test/${"á".repeat(900)}`, lessons: []
      }]
    });
    version += 1;
    assert.deepEqual(publicCatalog().courses, []);
  } finally {
    fs.readFileSync = readFileSync;
    fs.statSync = statSync;
    getCatalog();
  }
});

test("catalog API allows the production landing page only", async () => {
  const { handler } = require("../netlify/functions/catalog");
  const allowed = await handler({ httpMethod: "GET", headers: { origin: "https://nixart.io.vn" } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], "https://nixart.io.vn");
  assert.equal(allowed.headers.Vary, "Origin");

  const denied = await handler({ httpMethod: "GET", headers: { origin: "https://evil.example" } });
  assert.equal(denied.headers["Access-Control-Allow-Origin"], undefined);
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
