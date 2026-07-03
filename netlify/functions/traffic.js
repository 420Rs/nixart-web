const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS site_visits (
      id BIGSERIAL PRIMARY KEY,
      visitor_id VARCHAR(64) NOT NULL,
      path VARCHAR(200) NOT NULL DEFAULT '/',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS site_visits_created_idx ON site_visits (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS site_visits_visitor_idx ON site_visits (visitor_id, created_at DESC)`;
}

function cleanVisitor(value) {
  const text = String(value || "").trim();
  return /^[a-f0-9-]{16,64}$/i.test(text) ? text.slice(0, 64) : crypto.randomUUID();
}

exports.handler = async (event) => {
  try {
    await ensureTable();

    if (event.httpMethod === "POST") {
      let payload = {};
      try { payload = JSON.parse(event.body || "{}"); } catch (_) {}
      await sql`
        INSERT INTO site_visits (visitor_id, path)
        VALUES (${cleanVisitor(payload.visitorId)}, ${String(payload.path || "/").slice(0, 200)})
      `;
      return json(201, { ok: true });
    }

    if (event.httpMethod === "GET") {
      const [row] = await sql`
        SELECT
          COUNT(*)::INT AS total,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::INT AS today,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::INT AS week,
          COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= date_trunc('day', NOW()))::INT AS visitors_today,
          COUNT(DISTINCT visitor_id) FILTER (WHERE created_at >= NOW() - INTERVAL '5 minutes')::INT AS online
        FROM site_visits
      `;
      return json(200, row || { total: 0, today: 0, week: 0, visitors_today: 0, online: 0 });
    }

    return json(405, { error: "Phuong thuc khong duoc ho tro" });
  } catch (error) {
    console.error("traffic error", error);
    return json(500, { error: "Khong tai duoc traffic" });
  }
};
