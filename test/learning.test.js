const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.HLS_SIGNING_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";

const {
  canAccessCourse, cleanId, courseDeliveryMode, driveFolderId, effectiveDeliveryMode, escapeDiscordMarkdown, getCatalog, googleEmail, grantEmailAccess,
  getCourseViewStats, getLearningProgress, hasCourseAccess, hasPublishedLesson, isCourseContentReady, isCourseListed, isCourseSaleReady, isDriveCourseReady,
  isForumCourseSaleReady, normalizeLearningProgress, publicCatalog, recordLessonView, saveLearningProgress
} = require("../learning");
const { issueMediaToken, verifyMediaToken } = require("../netlify/functions/lib/media-token");

test("media token is scoped to one lesson and expires", () => {
  const token = issueMediaToken({ discordId: "123456789012345678", courseId: "course-a", lessonId: "lesson-1" });
  assert.equal(verifyMediaToken(token, "course-a", "lesson-1").sub, "123456789012345678");
  assert.equal(verifyMediaToken(token, "course-a", "lesson-2"), null);
  assert.equal(verifyMediaToken(`${token}x`, "course-a", "lesson-1"), null);
  assert.equal(verifyMediaToken(token, "course-a", "lesson-1", Math.floor(Date.now() / 1000) + 3601), null);

  const userId = "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9";
  const accountToken = issueMediaToken({ userId, courseId: "course-a", lessonId: "lesson-1" });
  assert.equal(verifyMediaToken(accountToken, "course-a", "lesson-1").sub, userId);
  assert.throws(() => issueMediaToken({ userId: "user@example.com", courseId: "course-a", lessonId: "lesson-1" }), /Invalid media token scope/);
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

test("free stream course grants access without a purchase", async () => {
  const course = {
    id: "free-course", planTier: "full", freeAccess: true, published: true, rightsVerified: true,
    deliveryMode: "STREAM", streamAvailable: true,
    lessons: [{ id: "lesson-1", title: "Bài 1", published: true }]
  };
  assert.equal(await hasCourseAccess({}, course), true);
  assert.equal(isCourseSaleReady({ ...course, saleEnabled: true, price: 50000 }), false);
});

test("learning progress stores one bounded resume point per course", async () => {
  assert.deepEqual(normalizeLearningProgress(75.9, 60.4), { positionSeconds: 60, durationSeconds: 60 });
  assert.throws(() => normalizeLearningProgress(-1, 60), /không hợp lệ/);
  assert.throws(() => normalizeLearningProgress(null, 60), /không hợp lệ/);
  assert.throws(() => normalizeLearningProgress(1, 90_000), /không hợp lệ/);

  const userId = "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9";
  const writes = [];
  const writeSql = async (strings, ...values) => {
    writes.push({ source: strings.join(" ? "), values });
    return [];
  };
  assert.deepEqual(await saveLearningProgress({
    userId, courseId: "course-a", lessonId: "lesson-2", positionSeconds: 125.8, durationSeconds: 600.2
  }, writeSql), { lessonId: "lesson-2", positionSeconds: 125, durationSeconds: 600 });
  assert.match(writes[0].source, /ON CONFLICT \(user_id, course_id\) DO UPDATE/);
  assert.deepEqual(writes[0].values.slice(1), ["course-a", "lesson-2", 125, 600]);

  const readSql = async () => [{
    lesson_id: "lesson-2", position_seconds: 125, duration_seconds: 600, updated_at: "2026-07-15T00:00:00.000Z"
  }];
  assert.deepEqual(await getLearningProgress(userId, "course-a", readSql), {
    lessonId: "lesson-2", positionSeconds: 125, durationSeconds: 600, updatedAt: "2026-07-15T00:00:00.000Z"
  });
});

test("lesson views count one session and active viewers", async () => {
  const userId = "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9";
  const sessionId = "a5a5a5a5-1111-4111-8111-123456789abc";
  const queries = [];
  const sql = async (strings, ...values) => {
    const source = strings.join(" ? ");
    queries.push({ source, values });
    if (source.includes("SELECT counters.lesson_id")) {
      return [{ lesson_id: "lesson-2", views: "17", watching: 3 }];
    }
    return [];
  };
  assert.deepEqual(await recordLessonView({
    userId, sessionId, courseId: "course-a", lessonId: "lesson-2"
  }, sql), {
    view: { lessonId: "lesson-2", views: 17, watching: 3 },
    views: [{ lessonId: "lesson-2", views: 17, watching: 3 }]
  });
  assert.match(queries[0].source, /ON CONFLICT \(session_id\) DO NOTHING/);
  assert.match(queries[1].source, /last_seen_at = NOW\(\)/);
  assert.deepEqual(await getCourseViewStats("course-a", sql), [{ lessonId: "lesson-2", views: 17, watching: 3 }]);
  await assert.rejects(recordLessonView({
    userId: "invalid", courseId: "course-a", lessonId: "lesson-2"
  }, sql), /không hợp lệ/);
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

test("Google OAuth requests identity only and verifies signed claims strictly", async () => {
  const previous = {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI
  };
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "http://localhost/api/google-auth";
  const googleAuth = require("../netlify/functions/google-auth");

  try {
    assert.deepEqual(googleAuth.GOOGLE_SCOPES, ["openid", "email", "profile"]);
    assert.equal(googleAuth.safeReturnTo("/learn?course=a&lesson=b"), "/learn?course=a&lesson=b");
    assert.equal(googleAuth.safeReturnTo("//evil.example/path"), "/learn");
    const response = await googleAuth.handler({
      httpMethod: "GET",
      headers: { host: "localhost" },
      queryStringParameters: { returnTo: "/learn?course=a&lesson=b" }
    });
    assert.equal(response.statusCode, 302);
    const authorize = new URL(response.headers.Location);
    assert.equal(authorize.hostname, "accounts.google.com");
    assert.deepEqual(authorize.searchParams.get("scope").split(" ").sort(), ["email", "openid", "profile"]);
    assert.equal(authorize.searchParams.has("access_type"), false);
    const state = googleAuth.decodeState(authorize.searchParams.get("state"));
    assert.ok(state?.n);
    assert.equal(authorize.searchParams.get("nonce"), state.n);

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: process.env.GOOGLE_OAUTH_CLIENT_ID,
      exp: now + 300,
      nonce: state.n,
      sub: "google-user-123",
      email: " User@Example.com ",
      email_verified: true,
      name: "Nixart User"
    };
    const external = googleAuth.validateGoogleClaims(claims, state.n, process.env.GOOGLE_OAUTH_CLIENT_ID, now);
    assert.equal(external.email, "user@example.com");
    assert.equal(external.emailAuthoritative, false);
    assert.equal(googleAuth.validateGoogleClaims({ ...claims, email: "user@gmail.com" }, state.n, process.env.GOOGLE_OAUTH_CLIENT_ID, now).emailAuthoritative, true);
    assert.equal(googleAuth.validateGoogleClaims({ ...claims, email: "user@studio.test", hd: "studio.test" }, state.n, process.env.GOOGLE_OAUTH_CLIENT_ID, now).emailAuthoritative, true);
    assert.equal(googleAuth.validateGoogleClaims({ ...claims, email: "user@alias.test", hd: "workspace.test" }, state.n, process.env.GOOGLE_OAUTH_CLIENT_ID, now).emailAuthoritative, true);
    assert.throws(() => googleAuth.validateGoogleClaims({ ...claims, email_verified: "true" }, state.n, process.env.GOOGLE_OAUTH_CLIENT_ID, now), /not verified/);
    assert.throws(() => googleAuth.validateGoogleClaims({ ...claims, aud: "other-client" }, state.n, process.env.GOOGLE_OAUTH_CLIENT_ID, now), /audience/);
    assert.throws(() => googleAuth.validateGoogleClaims({ ...claims, nonce: "wrong" }, state.n, process.env.GOOGLE_OAUTH_CLIENT_ID, now), /nonce/);
  } finally {
    if (previous.clientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = previous.clientId;
    if (previous.clientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.clientSecret;
    if (previous.redirectUri === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    else process.env.GOOGLE_OAUTH_REDIRECT_URI = previous.redirectUri;
  }
});

test("Google access grant CLI accepts individual courses only", () => {
  const { argumentsFrom } = require("../scripts/grant-google-access");
  assert.deepEqual(argumentsFrom(["--email", "user@gmail.com", "--course", "course-a"]), {
    email: "user@gmail.com",
    course: "course-a"
  });
  assert.throws(() => argumentsFrom(["--email", "user@gmail.com"]), /--course/);
  assert.throws(() => argumentsFrom(["--email", "user@gmail.com", "--plan", "full"]), /--plan/);
});

test("Google email access grants only individual stream courses to verified identities", async t => {
  const catalogPath = path.resolve(__dirname, "..", "content", "catalog.json");
  const deliveryPath = path.resolve(__dirname, "..", "content", "delivery.private.json");
  const catalogSource = Buffer.from(JSON.stringify({
    name: "NIXART test", tagline: "test", discordUrl: "https://discord.gg/test", plans: [],
    courses: [{
      id: "course-a", title: "Alpha", description: "test", price: 50000, planTier: "full",
      published: true, forumVisible: true, rightsVerified: true, deliveryMode: "STREAM",
      streamAvailable: true, saleEnabled: true, imageUrl: "", previewUrl: "",
      lessons: [{ id: "lesson-1", title: "Lesson", published: true }]
    }]
  }));
  const readFileSync = fs.readFileSync;
  const statSync = fs.statSync;
  t.mock.method(fs, "statSync", function (file, ...args) {
    if (path.resolve(String(file)) === catalogPath) return { size: catalogSource.length, mtimeMs: 1 };
    return statSync.call(this, file, ...args);
  });
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    const resolved = path.resolve(String(file));
    if (resolved === catalogPath) return catalogSource;
    if (resolved === deliveryPath) return args[0] ? JSON.stringify({ driveFolders: {} }) : Buffer.from(JSON.stringify({ driveFolders: {} }));
    return readFileSync.call(this, file, ...args);
  });

  await assert.rejects(
    grantEmailAccess({ email: "user@gmail.com", scope: "full", value: "full" }, async () => {
      throw new Error("Plan rejection must happen before SQL");
    }),
    /từng khóa STREAM/
  );

  const queries = [];
  const pendingSql = async (strings, ...values) => {
    const source = strings.join(" ? ");
    queries.push({ source, values });
    if (source.includes("FROM app_users")) return [];
    if (source.includes("SELECT purchase_code")) return [];
    if (source.includes("INSERT INTO purchase_orders")) return [];
    throw new Error(`Unexpected SQL: ${source.slice(0, 80)}`);
  };
  const granted = await grantEmailAccess({ email: " USER@GMAIL.COM ", scope: "course", value: "course-a" }, pendingSql);
  assert.equal(granted.email, "user@gmail.com");
  assert.equal(granted.userId, "");
  assert.equal(granted.expiresAt, null);
  assert.equal(granted.reused, false);
  assert.equal(queries.some(query => query.source.includes("'admin-email'") && query.values.includes("user@gmail.com")), true);

  await assert.rejects(
    grantEmailAccess({ email: "user+promo@gmail.com", scope: "course", value: "course-a" }, pendingSql),
    /không dùng alias \+tag/
  );

  const knownUserId = "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9";
  let knownQueryCount = 0;
  const knownIdentitySql = async strings => {
    const source = strings.join(" ? ");
    knownQueryCount += 1;
    if (source.includes("FROM app_users")) return [{ id: knownUserId, authoritative: true }];
    if (source.includes("SELECT purchase_code")) return [];
    if (source.includes("INSERT INTO purchase_orders")) return [];
    throw new Error("Grant must not run a fallible post-insert sync");
  };
  const knownGrant = await grantEmailAccess({ email: "known@gmail.com", scope: "course", value: "course-a" }, knownIdentitySql);
  assert.equal(knownGrant.userId, knownUserId);
  assert.equal(knownQueryCount, 3);

  const weakIdentitySql = async (strings) => {
    const source = strings.join(" ? ");
    if (source.includes("FROM app_users")) {
      return [{ id: "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9", authoritative: false }];
    }
    throw new Error("The grant must stop before writing an order");
  };
  await assert.rejects(
    grantEmailAccess({ email: "user@external.example", scope: "course", value: "course-a" }, weakIdentitySql),
    /Gmail\/Workspace/
  );

  const unknownWorkspaceSql = async (strings) => {
    const source = strings.join(" ? ");
    if (source.includes("FROM app_users")) return [];
    throw new Error("An unknown Workspace address must not create an order yet");
  };
  await assert.rejects(
    grantEmailAccess({ email: "user@studio.example", scope: "course", value: "course-a" }, unknownWorkspaceSql),
    /đăng nhập Google một lần/
  );
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
