const { neon } = require("@neondatabase/serverless");

let sqlClient;
function db() {
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  };
}

function requireAdmin(event) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const sentPassword = event.headers["x-admin-password"] || event.headers["X-Admin-Password"];
  return Boolean(adminPassword && sentPassword === adminPassword);
}

async function ensureSepayTable() {
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS sepay_transactions (
      id VARCHAR(100) PRIMARY KEY,
      purchase_code VARCHAR(30),
      reference_code VARCHAR(200),
      amount BIGINT NOT NULL,
      payload JSONB NOT NULL,
      match_status VARCHAR(30) NOT NULL DEFAULT 'received',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE sepay_transactions ADD COLUMN IF NOT EXISTS match_status VARCHAR(30) NOT NULL DEFAULT 'received'`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Phuong thuc khong duoc ho tro" });
  if (!requireAdmin(event)) return json(401, { error: "Sai mat khau admin" });

  try {
    const sql = db();
    await ensureSepayTable();
    const orders = await sql`
      SELECT purchase_code, course_title, email, payer_name, amount, status, delivery_type,
             transfer_reference, created_at, reviewed_at
      FROM purchase_orders
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const logs = await sql`
      SELECT id, purchase_code, reference_code, amount, match_status, created_at
      FROM sepay_transactions
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const summaryRows = await sql`
      SELECT status, COUNT(*)::int AS count
      FROM purchase_orders
      GROUP BY status
    `;
    return json(200, { orders, logs, summary: summaryRows });
  } catch (error) {
    console.error("admin orders error", error);
    return json(500, { error: "Khong tai duoc dashboard don hang" });
  }
};
