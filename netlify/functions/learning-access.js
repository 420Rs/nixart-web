const { cookie, getAuthenticatedUser } = require("./lib/auth");
const { COOKIE_NAME, issueMediaToken } = require("./lib/media-token");
const { cleanId, findCourse, findLesson, hasCourseAccess } = require("../../learning");

function json(statusCode, body, cookieValue) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (cookieValue) headers["Set-Cookie"] = cookieValue;
  return { statusCode, headers, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Phương thức không được hỗ trợ" });
  const courseId = cleanId(event.queryStringParameters?.course);
  const lessonId = cleanId(event.queryStringParameters?.lesson);
  const course = findCourse(courseId);
  const lesson = findLesson(course, lessonId);
  if (!course || !lesson) return json(404, { error: "Không tìm thấy bài học" });

  const user = await getAuthenticatedUser(event);
  if (!user?.discordId) return json(401, { error: "Vui lòng đăng nhập bằng Discord" });

  try {
    if (!await hasCourseAccess(user.discordId, course)) {
      return json(403, { error: "Bạn chưa mua khóa học hoặc gói tháng đã hết hạn" });
    }
    const mediaPath = `/media/${course.id}/${lesson.id}/`;
    const token = issueMediaToken({ discordId: user.discordId, courseId: course.id, lessonId: lesson.id });
    return json(200, {
      course: { id: course.id, title: course.title },
      lesson: { id: lesson.id, title: lesson.title },
      manifestUrl: `${mediaPath}index.m3u8`
    }, cookie(COOKIE_NAME, token, event, 3600, mediaPath));
  } catch (error) {
    console.error("learning access error", error);
    return json(500, { error: "Không cấp được quyền xem lúc này" });
  }
};
