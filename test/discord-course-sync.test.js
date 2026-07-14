const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildForumPost,
  buildHiddenForumMessage,
  courseIdFromMessage,
  existingThreadNames,
  indexExistingThreads,
  paymentButton,
  threadName,
  visibleCourses,
} = require("../scripts/sync-discord-courses");

test("forum sync is visible-only, idempotent and strips links", () => {
  const visible = { id: "blender", title: `  Blender ${"3D ".repeat(40)}`, description: "Xem [tại đây](https://pay.example) hoặc www.download.example", forumVisible: true, lessons: [{}, {}] };
  assert.deepEqual(visibleCourses({ courses: [visible, { id: "hidden" }] }), [visible]);
  assert.equal(Array.from(threadName(visible)).length, 100);

  const post = buildForumPost(visible);
  assert.equal(post.message.embeds[0].fields[0].value, "Chưa mở bán");
  assert.doesNotMatch(JSON.stringify(post), /https?:|www\.|image|download\.example/i);
  assert.deepEqual(post.message.allowed_mentions, { parse: [] });
  assert.equal(existingThreadNames([{ name: post.name, parent_id: "forum" }], [], "forum").has(post.name), true);
  assert.equal(existingThreadNames([{ name: post.name, parent_id: "other" }], [], "forum").has(post.name), false);
  assert.equal(courseIdFromMessage({ embeds: [{ footer: { text: "Mã khóa học: blender" } }] }), "blender");
});

test("payment button fails closed unless every sale flag is verified", () => {
  const base = { id: "blender", forumVisible: true, published: true, rightsVerified: true, price: 200000 };
  assert.deepEqual(paymentButton(base), { type: 2, style: 1, label: "Thanh toán", custom_id: "buy_course:blender", disabled: false });
  const post = buildForumPost(base);
  assert.equal(post.message.embeds[0].fields[0].value, "Đang mở bán");
  assert.equal(post.message.embeds[0].fields[2].value, "200.000đ");
  for (const override of [{ forumVisible: false }, { published: false }, { rightsVerified: false }, { price: 0 }, { price: "" }]) {
    const button = paymentButton({ ...base, ...override });
    assert.equal(button.disabled, true);
    assert.equal(button.style, 2);
    assert.equal(button.label, "Thanh toán — chưa mở");
  }
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
