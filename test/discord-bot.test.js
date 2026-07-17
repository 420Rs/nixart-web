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
