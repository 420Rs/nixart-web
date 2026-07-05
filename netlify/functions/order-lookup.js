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

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

function publicOrder(row) {
  const statusText = {
    pending: "Đã tạo đơn, đang chờ thanh toán",
    processing: "Đang xử lý",
    paid: row.delivery_type === "manual" ? "Đã nhận tiền, chờ admin giao tài khoản" : "Đã nhận tiền, đang chờ cấp quyền",
    approved: row.delivery_type === "manual" ? "Đã giao tài khoản" : "Đã cấp quyền khóa học",
    rejected: "Đơn đã bị từ chối"
  };
  return {
    purchase_code: row.purchase_code,
    course_title: row.course_title,
    amount: Number(row.amount || 0),
    status: row.status,
    status_text: statusText[row.status] || row.status,
    delivery_type: row.delivery_type,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    has_delivery: Boolean(row.delivery_content)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Phuong thuc khong duoc ho tro" });
  const code = clean(event.queryStringParameters?.code, 30).toUpperCase();
  const email = clean(event.queryStringParameters?.email, 254).toLowerCase();
  if (!/^NIX[A-Z0-9]{6,12}$/.test(code) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: "Nhap ma don NIX va email hop le" });
  }

  try {
    const sql = db();
    const rows = await sql`
      SELECT purchase_code, course_title, amount, status, delivery_type, delivery_content, created_at, reviewed_at
      FROM purchase_orders
      WHERE purchase_code = ${code} AND email = ${email}
      LIMIT 1
    `;
    if (!rows.length) return json(404, { error: "Khong tim thay don hang" });
    return json(200, { order: publicOrder(rows[0]) });
  } catch (error) {
    console.error("order lookup error", error);
    return json(500, { error: "Khong tra cuu duoc don hang" });
  }
};
