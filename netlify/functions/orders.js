const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { getAuthenticatedUser } = require("./lib/auth");

const sql = neon(process.env.DATABASE_URL);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function cleanText(value, max) {
  return String(value || "").trim().replace(/[\u0000-\u001f]/g, " ").slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function ensureOrdersTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id UUID PRIMARY KEY,
      purchase_code VARCHAR(30) UNIQUE NOT NULL,
      token_hash VARCHAR(64) UNIQUE NOT NULL,
      course_id VARCHAR(100) NOT NULL,
      course_title VARCHAR(300) NOT NULL,
      drive_folder_id VARCHAR(300) NOT NULL,
      email VARCHAR(254) NOT NULL,
      payer_name VARCHAR(200) NOT NULL,
      transfer_reference VARCHAR(200) NOT NULL DEFAULT '',
      amount BIGINT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      drive_permission_id VARCHAR(300),
      delivery_type VARCHAR(20) NOT NULL DEFAULT 'drive',
      auth_user_id VARCHAR(100),
      delivery_content TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    )
  `;
  await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) NOT NULL DEFAULT 'drive'`;
  await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS auth_user_id VARCHAR(100)`;
  await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_content TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS purchase_orders_status_idx ON purchase_orders (status, created_at DESC)`;
}

async function notifyDiscord(order, reviewUrl) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("Chua cau hinh DISCORD_WEBHOOK_URL");

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Nixart Orders",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "Yêu cầu xác nhận thanh toán",
        color: 0xff9e2c,
        fields: [
          { name: "Sản phẩm", value: order.courseTitle.slice(0, 1024) },
          { name: "Số tiền", value: `${Number(order.amount).toLocaleString("vi-VN")} đ`, inline: true },
          { name: "Mã đơn", value: order.purchaseCode, inline: true },
          { name: "Email Google", value: order.email.slice(0, 1024) },
          { name: "Người chuyển", value: order.payerName.slice(0, 1024), inline: true },
          { name: "Mã giao dịch", value: order.transferReference || "Không cung cấp", inline: true },
          { name: "Giao hàng", value: order.deliveryType === "manual" ? "Admin giao tài khoản thủ công" : "Tự động cấp Google Drive" }
        ],
        description: `[Mở trang kiểm tra và duyệt đơn](${reviewUrl})`,
        timestamp: new Date().toISOString()
      }]
    })
  });

  if (!response.ok) throw new Error(`Discord webhook loi ${response.status}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    try {
      const user = await getAuthenticatedUser(event);
      if (!user) return json(401, { error: "Vui long dang nhap" });
      await ensureOrdersTable();
      const rows = await sql`
        SELECT purchase_code, course_title, amount, status, delivery_content, created_at, reviewed_at
        FROM purchase_orders
        WHERE auth_user_id = ${user.id} AND delivery_type = 'manual'
        ORDER BY created_at DESC LIMIT 100
      `;
      return json(200, { orders: rows });
    } catch (error) {
      console.error("list orders error", error);
      return json(500, { error: "Khong tai duoc don hang" });
    }
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Phuong thuc khong duoc ho tro" });

  try {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (_) {
      return json(400, { error: "Du lieu khong hop le" });
    }

    const courseId = cleanText(payload.courseId, 100).toLowerCase();
    let email = cleanText(payload.email, 254).toLowerCase();
    const payerName = cleanText(payload.payerName, 200);
    const transferReference = cleanText(payload.transferReference, 200);
    const purchaseCode = cleanText(payload.purchaseCode, 30).toUpperCase();

    if (!courseId || !payerName || !/^NIX[A-Z0-9]{6,12}$/.test(purchaseCode)) {
      return json(400, { error: "Vui long kiem tra ten nguoi chuyen va ma don" });
    }

    await ensureOrdersTable();
    const stateRows = await sql`SELECT data FROM studio_state WHERE id = 1`;
    const courses = Array.isArray(stateRows[0]?.data?.courses) ? stateRows[0].data.courses : [];
    const course = courses.find((item) => String(item.id || "").toLowerCase() === courseId);

    const deliveryType = course?.contentType === "account" ? "manual" : "drive";
    if (!course || !course.saleEnabled || !course.price || (deliveryType === "drive" && !course.driveFolderId)) {
      return json(409, { error: "Khoa hoc chua san sang de ban hoac giao tu dong" });
    }

    const authUser = deliveryType === "manual" ? await getAuthenticatedUser(event) : null;
    if (deliveryType === "manual" && !authUser) return json(401, { error: "Vui long dang nhap de mua tai khoan" });
    if (authUser) email = authUser.email.toLowerCase();
    if (!validEmail(email)) return json(400, { error: "Email khong hop le" });

    const duplicate = await sql`
      SELECT id FROM purchase_orders
      WHERE purchase_code = ${purchaseCode}
         OR (email = ${email} AND course_id = ${courseId} AND status IN ('pending', 'processing', 'approved'))
      LIMIT 1
    `;
    if (duplicate.length) return json(409, { error: "Yeu cau nay da ton tai. Vui long cho admin xu ly" });

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("hex");
    await sql`
      INSERT INTO purchase_orders (
        id, purchase_code, token_hash, course_id, course_title, drive_folder_id,
        email, payer_name, transfer_reference, amount, delivery_type, auth_user_id
      ) VALUES (
        ${id}, ${purchaseCode}, ${hashToken(token)}, ${courseId}, ${String(course.title)},
        ${String(course.driveFolderId || "")}, ${email}, ${payerName}, ${transferReference}, ${Number(course.price)}, ${deliveryType}, ${authUser?.id || null}
      )
    `;

    const baseUrl = String(process.env.URL || process.env.DEPLOY_PRIME_URL || `https://${event.headers.host}`).replace(/\/$/, "");
    const reviewUrl = `${baseUrl}/review?token=${encodeURIComponent(token)}`;

    try {
      await notifyDiscord({
        courseTitle: String(course.title), amount: Number(course.price), purchaseCode,
        email, payerName, transferReference, deliveryType
      }, reviewUrl);
    } catch (error) {
      await sql`DELETE FROM purchase_orders WHERE id = ${id}`;
      throw error;
    }

    return json(201, { ok: true, purchaseCode, message: "Da gui yeu cau. Vui long cho admin xac nhan" });
  } catch (error) {
    console.error("orders error", error);
    return json(500, { error: "Khong gui duoc yeu cau. Vui long thu lai sau" });
  }
};
