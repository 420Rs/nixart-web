const test = require("node:test");
const assert = require("node:assert/strict");

test("progress API authenticates, checks access and reads or writes one resume point", async t => {
  const auth = require("../netlify/functions/lib/auth");
  const learning = require("../learning");
  const handlerPath = require.resolve("../netlify/functions/learning-progress");
  const originals = {
    getAuthenticatedUser: auth.getAuthenticatedUser,
    findCourse: learning.findCourse,
    findLesson: learning.findLesson,
    getCourseViewStats: learning.getCourseViewStats,
    getLearningProgress: learning.getLearningProgress,
    hasCourseAccess: learning.hasCourseAccess,
    recordLessonView: learning.recordLessonView,
    saveLearningProgress: learning.saveLearningProgress
  };
  let user = { id: "9b9f2602-e8db-4b6b-8d8f-58ef3cffebd9" };
  let allowed = true;
  auth.getAuthenticatedUser = async () => user;
  learning.findCourse = id => id === "course-a" ? { id, lessons: [] } : null;
  learning.findLesson = (_, id) => id === "lesson-2" ? { id } : null;
  learning.hasCourseAccess = async () => allowed;
  learning.getLearningProgress = async () => ({ lessonId: "lesson-2", positionSeconds: 125, durationSeconds: 600 });
  learning.getCourseViewStats = async () => [{ lessonId: "lesson-2", views: 12, watching: 2 }];
  learning.recordLessonView = async input => ({
    view: { lessonId: input.lessonId, views: 13, watching: 3 },
    views: [{ lessonId: input.lessonId, views: 13, watching: 3 }]
  });
  learning.saveLearningProgress = async input => ({
    lessonId: input.lessonId,
    positionSeconds: Math.floor(input.positionSeconds),
    durationSeconds: Math.floor(input.durationSeconds)
  });
  delete require.cache[handlerPath];
  const { handler } = require(handlerPath);
  t.after(() => {
    Object.assign(auth, { getAuthenticatedUser: originals.getAuthenticatedUser });
    Object.assign(learning, originals);
    delete require.cache[handlerPath];
  });

  const getResponse = await handler({ httpMethod: "GET", queryStringParameters: { course: "course-a" } });
  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(getResponse.body), {
    progress: { lessonId: "lesson-2", positionSeconds: 125, durationSeconds: 600 },
    views: [{ lessonId: "lesson-2", views: 12, watching: 2 }]
  });

  const postResponse = await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      course: "course-a", lesson: "lesson-2", positionSeconds: 150.7, durationSeconds: 600.2
    })
  });
  assert.equal(postResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(postResponse.body).progress, { lessonId: "lesson-2", positionSeconds: 150, durationSeconds: 600 });

  const viewResponse = await handler({
    httpMethod: "POST",
    body: JSON.stringify({
      action: "view", course: "course-a", lesson: "lesson-2",
    })
  });
  assert.equal(viewResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(viewResponse.body), {
    ok: true,
    view: { lessonId: "lesson-2", views: 13, watching: 3 },
    views: [{ lessonId: "lesson-2", views: 13, watching: 3 }]
  });

  allowed = false;
  assert.equal((await handler({ httpMethod: "GET", queryStringParameters: { course: "course-a" } })).statusCode, 403);
  user = null;
  assert.equal((await handler({ httpMethod: "GET", queryStringParameters: { course: "course-a" } })).statusCode, 401);
});
