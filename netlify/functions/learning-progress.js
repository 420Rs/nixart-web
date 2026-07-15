const { getAuthenticatedUser } = require("./lib/auth");
const {
  cleanId,
  findCourse,
  findLesson,
  getCourseViewStats,
  getLearningProgress,
  hasCourseAccess,
  recordLessonView,
  saveLearningProgress
} = require("../../learning");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

exports.handler = async event => {
  if (!["GET", "POST"].includes(event.httpMethod)) return json(405, { error: "Phương thức không được hỗ trợ" });
  const user = await getAuthenticatedUser(event);
  if (!user?.id) return json(401, { error: "Vui lòng đăng nhập để tiếp tục" });

  try {
    let payload = event.queryStringParameters || {};
    if (event.httpMethod === "POST") {
      try { payload = JSON.parse(event.body || "{}"); }
      catch { return json(400, { error: "Dữ liệu không hợp lệ" }); }
    }
    const course = findCourse(cleanId(payload.course));
    if (!course) return json(404, { error: "Không tìm thấy khóa học" });
    if (!await hasCourseAccess(user, course)) return json(403, { error: "Bạn chưa có quyền truy cập khóa học" });

    if (event.httpMethod === "GET") {
      const [progress, views] = await Promise.all([
        getLearningProgress(user.id, course.id),
        getCourseViewStats(course.id)
      ]);
      return json(200, { progress, views });
    }

    const lesson = findLesson(course, cleanId(payload.lesson));
    if (!lesson) return json(404, { error: "Không tìm thấy bài học" });
    const progress = await saveLearningProgress({
      userId: user.id,
      courseId: course.id,
      lessonId: lesson.id,
      positionSeconds: payload.positionSeconds,
      durationSeconds: payload.durationSeconds
    });
    const view = payload.sessionId ? await recordLessonView({
      userId: user.id,
      courseId: course.id,
      lessonId: lesson.id,
      sessionId: payload.sessionId
    }) : null;
    return json(200, { ok: true, progress, view });
  } catch (error) {
    if (/không hợp lệ/i.test(error.message || "")) return json(400, { error: error.message });
    console.error("learning progress error", error);
    return json(500, { error: "Không lưu được tiến độ lúc này" });
  }
};
