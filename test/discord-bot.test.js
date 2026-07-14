const test = require("node:test");
const assert = require("node:assert/strict");
const { driveEmailModal, isDiscordBotReady } = require("../discord-bot");

test("Drive purchase modal asks for one Google email", () => {
  assert.equal(isDiscordBotReady(), false);
  const modal = driveEmailModal({ id: "blender-drive" }).toJSON();
  assert.equal(modal.custom_id, "drive_email:blender-drive");
  assert.equal(modal.components.length, 1);
  assert.equal(modal.components[0].components[0].custom_id, "google_email");
  assert.equal(modal.components[0].components[0].required, true);
  assert.equal(modal.components[0].components[0].max_length, 254);
});
