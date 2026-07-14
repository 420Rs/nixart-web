const { neon } = require("@neondatabase/serverless");
const { getAuthenticatedUser } = require("./lib/auth");
const { ensureLearningTables } = require("../../learning");

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

exports.handler = async (event) => {
  if (event.httpMethod === "POST") {
    return json(410, { error: "Thanh toán trên website đã đóng. Vui lòng dùng lệnh /mua trong Discord." });
  }
  if (event.httpMethod !== "GET") return json(405, { error: "Phương thức không được hỗ trợ" });

  try {
    const user = await getAuthenticatedUser(event);
    if (!user) return json(401, { error: "Vui lòng đăng nhập" });
    await ensureLearningTables();
    const sql = db();
    const rows = await sql`
      SELECT purchase_code, course_title, amount, status, delivery_content, created_at, reviewed_at
      FROM purchase_orders
      WHERE auth_user_id = ${user.id} AND delivery_type = 'manual'
      ORDER BY created_at DESC LIMIT 100
    `;
    return json(200, { orders: rows });
  } catch (error) {
    console.error("list orders error", error);
    return json(500, { error: "Không tải được đơn hàng" });
  }
};
