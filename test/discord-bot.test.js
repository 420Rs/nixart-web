const test = require("node:test");
const assert = require("node:assert/strict");
const { driveEmailModal, isDiscordBotReady, paymentApprovedMessage } = require("../discord-bot");

test("Drive purchase modal asks for one Google email", () => {
  assert.equal(isDiscordBotReady(), false);
  const modal = driveEmailModal({ id: "blender-drive" }).toJSON();
  assert.equal(modal.custom_id, "drive_email:blender-drive");
  assert.equal(modal.components.length, 1);
  assert.equal(modal.components[0].components[0].custom_id, "google_email");
  assert.equal(modal.components[0].components[0].required, true);
  assert.equal(modal.components[0].components[0].max_length, 254);
});

test("approved stream payment returns a lesson picker", () => {
  const catalog = { courses: [{
    id: "blender", title: "Blender Course", description: "Learn Blender", planTier: "basic",
    published: true, rightsVerified: true, deliveryMode: "STREAM", streamAvailable: true,
    lessons: [
      { id: "lesson-1", title: "Lesson 1", published: true },
      { id: "lesson-2", title: "Lesson 2", published: true }
    ]
  }] };
  const message = paymentApprovedMessage({
    course_id: "blender", course_title: "Blender Course", access_scope: "course"
  }, catalog);
  const json = message.components[0].toJSON();
  assert.match(message.content, /Thanh toán thành công/);
  assert.equal(json.components[0].custom_id, "learn_lesson:blender");
  assert.equal(json.components[0].options.length, 2);
});

test("approved RVP payment sends a one-time code and common download link", () => {
  const old = process.env.RVP_LICENSE_SECRET;
  process.env.RVP_LICENSE_SECRET = "test-secret-that-is-at-least-32-bytes-long";
  try {
    const message = paymentApprovedMessage({
      id: "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9",
      course_id: "blender-rvp", course_title: "Blender Offline", delivery_type: "rvp",
      rvp_download_url: "https://drive.google.com/file/d/example/view"
    });
    assert.match(message.content, /Mã kích hoạt một thiết bị/);
    assert.match(message.content, /[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}/);
    assert.equal(message.components[0].toJSON().components[0].url, "https://drive.google.com/file/d/example/view");
  } finally {
    if (old === undefined) delete process.env.RVP_LICENSE_SECRET; else process.env.RVP_LICENSE_SECRET = old;
  }
});
