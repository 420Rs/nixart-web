const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildForumPost,
  buildHiddenForumMessage,
  courseIdFromMessage,
  ensureStreamTags,
  existingThreadNames,
  indexExistingThreads,
  mergeAppliedStreamTag,
  paymentButton,
  previewButton,
  safeHttpsUrl,
  streamTagName,
  threadName,
  validateCatalogForSync,
  visibleCourses,
} = require("../scripts/sync-discord-courses");

test("forum sync is visible-only, idempotent and strips links", () => {
  const visible = { id: "blender", title: `  Blender ${"3D ".repeat(40)}`, description: "Xem [tại đây](https://pay.example) hoặc www.download.example", forumVisible: true, lessons: [{}, {}] };
  assert.deepEqual(visibleCourses({ courses: [visible, { id: "hidden" }] }), [visible]);
  assert.equal(Array.from(threadName(visible)).length, 100);

  const post = buildForumPost(visible);
  assert.equal(post.message.embeds[0].fields[2].value, "0");
  assert.equal(post.message.embeds[0].fields[0].value, "Chưa mở bán");
  assert.doesNotMatch(JSON.stringify(post), /https?:|www\.|image|download\.example/i);
  assert.deepEqual(post.message.allowed_mentions, { parse: [] });
  assert.equal(existingThreadNames([{ name: post.name, parent_id: "forum" }], [], "forum").has(post.name), true);
  assert.equal(existingThreadNames([{ name: post.name, parent_id: "other" }], [], "forum").has(post.name), false);
  assert.equal(courseIdFromMessage({ embeds: [{ footer: { text: "Mã khóa học: blender" } }] }), "blender");
});

test("payment button fails closed unless every sale flag is verified", () => {
  const base = {
    id: "blender", forumVisible: true, published: true, rightsVerified: true, streamAvailable: true, saleEnabled: true, price: 200000,
    lessons: [{ id: "lesson-1", title: "Bài 1", published: true }]
  };
  assert.deepEqual(paymentButton(base), { type: 2, style: 1, label: "Thanh toán", custom_id: "buy_course:blender", disabled: false });
  const post = buildForumPost(base);
  assert.equal(post.message.embeds[0].fields[0].value, "Đang mở bán");
  assert.equal(post.message.embeds[0].fields[3].value, "200.000đ");
  for (const override of [{ forumVisible: false }, { published: false }, { rightsVerified: false }, { streamAvailable: false }, { saleEnabled: false }, { lessons: [] }, { price: 0 }, { price: "" }]) {
    const button = paymentButton({ ...base, ...override });
    assert.equal(button.disabled, true);
    assert.equal(button.style, 2);
    assert.equal(button.label, "Thanh toán — chưa mở");
  }
});

test("course cover and preview accept safe HTTPS URLs only", () => {
  const course = {
    id: "blender",
    title: "Blender",
    forumVisible: true,
    rightsVerified: true,
    published: true,
    streamAvailable: true,
    lessons: [{ id: "lesson-1", title: "Lesson 1", published: true }],
    imageUrl: "https://cdn.example/cover.jpg",
    previewUrl: "https://video.example/watch?v=1",
  };
  const post = buildForumPost(course);
  assert.equal(post.message.embeds[0].image.url, "https://cdn.example/cover.jpg");
  assert.equal(post.message.embeds[0].fields[1].value, "STREAM");
  assert.deepEqual(post.message.components[0].components[1], {
    type: 2,
    style: 5,
    label: "Xem trước",
    url: "https://video.example/watch?v=1",
  });
  assert.equal(safeHttpsUrl("javascript:alert(1)"), "");
  assert.equal(safeHttpsUrl("https://user:pass@example.com/private"), "");
  assert.equal(previewButton({ previewUrl: "http://example.com" }), null);
  assert.equal(previewButton({ rightsVerified: false, previewUrl: "https://example.com" }), null);
  assert.equal(safeHttpsUrl(`https://example.com/${"á".repeat(900)}`), "");
  const prefix = "https://example.com/";
  const url512 = prefix + "a".repeat(512 - prefix.length);
  assert.equal(previewButton({ rightsVerified: true, previewUrl: url512 }).url.length, 512);
  assert.equal(previewButton({ rightsVerified: true, previewUrl: `${url512}a` }), null);

  const unsafe = buildForumPost({ ...course, imageUrl: "data:image/png;base64,abc", previewUrl: "javascript:alert(1)" });
  assert.equal(unsafe.message.embeds[0].image, undefined);
  assert.equal(unsafe.message.components[0].components.length, 1);

  const unverified = buildForumPost({ ...course, rightsVerified: false });
  assert.equal(unverified.message.embeds[0].image, undefined);
  assert.equal(unverified.message.components[0].components.length, 1);
});

test("stream tags are created once and merged without removing other tags", async () => {
  let patchBody;
  const rest = {
    patch: async (_route, { body }) => {
      patchBody = body;
      return {
        id: "forum",
        available_tags: body.available_tags.map((tag, index) => ({ ...tag, id: tag.id || `tag-${index}` })),
      };
    },
  };
  const ids = await ensureStreamTags(rest, { id: "forum", available_tags: [{ id: "level", name: "Beginner" }] });
  assert.equal(patchBody.available_tags.length, 3);
  assert.ok(ids.STREAM);
  assert.ok(ids["NON-STREAM"]);
  const ready = {
    id: "a", published: true, rightsVerified: true, streamAvailable: true,
    lessons: [{ id: "lesson-1", title: "Lesson 1", published: true }],
  };
  assert.deepEqual(mergeAppliedStreamTag(["level", ids["NON-STREAM"]], ids, ready), ["level", ids.STREAM]);
  assert.equal(streamTagName({ ...ready, lessons: [] }), "NON-STREAM");
  assert.equal(streamTagName({ streamAvailable: false }), "NON-STREAM");
});

test("catalog validation blocks malformed data and mass archive accidents", () => {
  const course = {
    id: "blender",
    title: "Blender",
    description: "Khóa học 3D",
    price: 200000,
    planTier: "full",
    forumVisible: true,
    published: false,
    rightsVerified: false,
    streamAvailable: false,
    saleEnabled: false,
    lessons: [],
  };
  assert.doesNotThrow(() => validateCatalogForSync({ courses: [course] }));
  assert.throws(() => validateCatalogForSync({ courses: [] }), /ít nhất một khóa học/);
  assert.throws(() => validateCatalogForSync({ courses: [{ ...course, forumVisible: false }] }), /Không có khóa học nào/);
  assert.throws(() => validateCatalogForSync({ courses: [course, { ...course, title: "Bản sao" }] }), /trùng/);
  assert.throws(() => validateCatalogForSync({ courses: [{ ...course, price: 2.5 }] }), /Giá/);
  assert.throws(() => validateCatalogForSync({ courses: [{ ...course, previewUrl: "javascript:alert(1)" }] }), /URL HTTPS/);
  assert.throws(() => validateCatalogForSync({ courses: [{ ...course, previewUrl: `https://example.com/${"a".repeat(500)}` }] }), /512/);
  assert.throws(() => validateCatalogForSync({ courses: [{ ...course, title: "Blender\u202Egpj.exe" }] }), /điều khiển/);
});

test("forum upsert indexes only starter posts authored by this bot", async () => {
  const messages = {
    owned: { author: { id: "bot" }, embeds: [{ footer: { text: "Mã khóa học: blender" } }] },
    foreign: { author: { id: "other" }, embeds: [{ footer: { text: "Mã khóa học: forged" } }] },
  };
  const rest = { get: async route => messages[route.split("/")[2]] };
  const index = await indexExistingThreads(rest, [
    { id: "owned", parent_id: "forum" },
    { id: "foreign", parent_id: "forum" },
  ], "forum", "bot");
  assert.equal(index.get("blender").id, "owned");
  assert.equal(index.has("forged"), false);
});

test("removed forum courses are archived with payment disabled", () => {
  const message = buildHiddenForumMessage("blender", "Blender Course");
  assert.equal(message.embeds[0].fields[0].value, "Đã ẩn khỏi danh mục");
  assert.equal(message.components[0].components[0].disabled, true);
});
