const { neon } = require("@neondatabase/serverless");

// Du lieu goc, dung khi database con trong
const DEFAULT_STATE = {
  name: "VOICE STUDIO",
  tagline: "Dich vu long tieng khoa hoc chuyen nghiep",
  facebook: "",
  discord: "",
  courses: []
};

const sql = neon(process.env.DATABASE_URL);

// Tao bang neu chua co, va dam bao co dong du lieu id=1
async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS studio_state (
      id INT PRIMARY KEY,
      data JSONB NOT NULL
    )
  `;
  await sql`
    INSERT INTO studio_state (id, data)
    VALUES (1, ${JSON.stringify(DEFAULT_STATE)})
    ON CONFLICT (id) DO NOTHING
  `;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    await ensureTable();

    // DOC du lieu - ai cung goi duoc
    if (event.httpMethod === "GET") {
      const rows = await sql`SELECT data FROM studio_state WHERE id = 1`;
      return json(200, rows[0]?.data ?? DEFAULT_STATE);
    }

    // GHI du lieu - phai co mat khau admin dung
    if (event.httpMethod === "POST") {
      const adminPassword = process.env.ADMIN_PASSWORD;
      const sentPassword = event.headers["x-admin-password"];
      if (!adminPassword || sentPassword !== adminPassword) {
        return json(401, { error: "Sai mat khau admin" });
      }

      let payload;
      try {
        payload = JSON.parse(event.body || "{}");
      } catch (error) {
        return json(400, { error: "Du lieu gui len khong hop le" });
      }

      // Chi giu dung 3 truong, chong du lieu rac
      const clean = {
        name: String(payload.name || "VOICE STUDIO").slice(0, 200),
        tagline: String(payload.tagline || "").slice(0, 500),
        facebook: String(payload.facebook || "").slice(0, 2000),
        discord: String(payload.discord || "").slice(0, 2000),
        courses: Array.isArray(payload.courses)
          ? payload.courses.slice(0, 500).map((course) => ({
              title: String(course.title || "").slice(0, 300),
              image: String(course.image || "").slice(0, 2000),
              status: ["doing", "pending", "done"].includes(course.status) ? course.status : "pending",
              progress: Math.max(0, Math.min(100, parseInt(course.progress, 10) || 0)),
              eta: String(course.eta || "").slice(0, 200)
            }))
          : []
      };

      await sql`UPDATE studio_state SET data = ${JSON.stringify(clean)} WHERE id = 1`;
      return json(200, { ok: true, data: clean });
    }

    return json(405, { error: "Phuong thuc khong duoc ho tro" });
  } catch (error) {
    return json(500, { error: "Loi server", detail: String(error.message || error) });
  }
};
