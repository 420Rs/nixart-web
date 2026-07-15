const test = require("node:test");
const assert = require("node:assert/strict");

process.env.HLS_SIGNING_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";

test("learning access records the viewer before returning the manifest", async t => {
  const auth = require("../netlify/functions/lib/auth");
  const learning = require("../learning");
  const handlerPath = require.resolve("../netlify/functions/learning-access");
  const originals = {
    getAuthenticatedUser: auth.getAuthenticatedUser,
    findCourse: learning.findCourse,
    findLesson: learning.findLesson,
    hasCourseAccess: learning.hasCourseAccess,
    recordLessonView: learning.recordLessonView
  };
  let recorded;
  auth.getAuthenticatedUser = async () => ({ id: "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9" });
  learning.findCourse = id => id === "course-a" ? { id, title: "Course A" } : null;
  learning.findLesson = (_, id) => id === "lesson-1" ? { id, title: "Lesson 1" } : null;
  learning.hasCourseAccess = async () => true;
  learning.recordLessonView = async input => {
    recorded = input;
    return { view: { lessonId: input.lessonId, views: 1, watching: 1 }, views: [{ lessonId: input.lessonId, views: 1, watching: 1 }] };
  };
  delete require.cache[handlerPath];
  const { handler } = require(handlerPath);
  t.after(() => {
    Object.assign(auth, { getAuthenticatedUser: originals.getAuthenticatedUser });
    Object.assign(learning, originals);
    delete require.cache[handlerPath];
  });

  const response = await handler({
    httpMethod: "GET",
    headers: { host: "learn.nixart.io.vn", "x-forwarded-proto": "https" },
    queryStringParameters: { course: "course-a", lesson: "lesson-1" }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(recorded, {
    userId: "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9",
    courseId: "course-a",
    lessonId: "lesson-1"
  });
  assert.deepEqual(JSON.parse(response.body).views, [{ lessonId: "lesson-1", views: 1, watching: 1 }]);
});
