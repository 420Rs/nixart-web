const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("learning page renders a safe course lesson picker", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "learn.html"), "utf8");
  assert.match(page, /id="lesson-list"/);
  assert.match(page, /\.lesson-list\s*\{[^}]*display:\s*block/s);
  assert.match(page, /getJson\("\/api\/catalog"\)/);
  assert.match(page, /new URLSearchParams\(\{ course: courseId, lesson: lesson\.id \}\)/);
  assert.match(page, /setAttribute\("aria-current", "page"\)/);
  assert.match(page, /fetch\("\/api\/learning-progress"/);
  assert.match(page, /video\.addEventListener\("timeupdate"/);
  assert.match(page, /video\.currentTime = progress\.positionSeconds/);
  assert.doesNotMatch(page, /lesson-list\.innerHTML/);
});
