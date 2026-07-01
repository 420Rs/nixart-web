const { neon } = require("@neondatabase/serverless");

// Du lieu goc, dung khi database con trong
const DEFAULT_STATE = {
  name: "VOICE STUDIO",
  tagline: "Dich vu long tieng khoa hoc chuyen nghiep",
  facebook: "",
  discord: "",
  bankBin: "970422",
  bankAccount: "0965672650",
  bankAccountName: "VU THANH AN",
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

function courseId(value, title, index) {
  const existing = String(value || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80);
  if (existing) return existing;
  const slug = String(title || "course")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "course"}-${index + 1}`;
}

function publicState(data) {
  return {
    ...DEFAULT_STATE,
    ...data,
    bankBin: data.bankBin || DEFAULT_STATE.bankBin,
    bankAccount: data.bankAccount || DEFAULT_STATE.bankAccount,
    bankAccountName: data.bankAccountName || DEFAULT_STATE.bankAccountName,
    courses: Array.isArray(data.courses)
      ? data.courses.map(({ driveFolderId, ...course }) => ({
          ...course,
          deliveryReady: Boolean(driveFolderId)
        }))
      : []
  };
}

exports.handler = async (event) => {
  try {
    await ensureTable();

    // DOC du lieu - ai cung goi duoc
    if (event.httpMethod === "GET") {
      const rows = await sql`SELECT data FROM studio_state WHERE id = 1`;
      return json(200, publicState(rows[0]?.data ?? DEFAULT_STATE));
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

      const currentRows = await sql`SELECT data FROM studio_state WHERE id = 1`;
      const currentCourses = Array.isArray(currentRows[0]?.data?.courses) ? currentRows[0].data.courses : [];
      const oldFolders = new Map(currentCourses.map((course, index) => [
        courseId(course.id, course.title, index),
        String(course.driveFolderId || "")
      ]));

      const clean = {
        name: String(payload.name || "VOICE STUDIO").slice(0, 200),
        tagline: String(payload.tagline || "").slice(0, 500),
        facebook: String(payload.facebook || "").slice(0, 2000),
        discord: String(payload.discord || "").slice(0, 2000),
        bankBin: String(payload.bankBin || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20),
        bankAccount: String(payload.bankAccount || "").replace(/\s/g, "").slice(0, 50),
        bankAccountName: String(payload.bankAccountName || "").slice(0, 200),
        courses: Array.isArray(payload.courses)
          ? payload.courses.slice(0, 500).map((course, index) => {
            const id = courseId(course.id, course.title, index);
            const submittedFolder = String(course.driveFolderId || "").trim().slice(0, 300);
            return {
              id,
              title: String(course.title || "").slice(0, 300),
              image: String(course.image || "").slice(0, 2000),
              description: String(course.description || "").slice(0, 2000),
              price: Math.max(0, Math.min(1000000000, parseInt(course.price, 10) || 0)),
              saleEnabled: Boolean(course.saleEnabled),
              driveFolderId: submittedFolder || oldFolders.get(id) || "",
              status: ["doing", "pending", "done"].includes(course.status) ? course.status : "pending",
              progress: Math.max(0, Math.min(100, parseInt(course.progress, 10) || 0)),
              eta: String(course.eta || "").slice(0, 200)
            };
          })
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
