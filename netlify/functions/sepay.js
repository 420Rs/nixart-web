const { neon } = require("@neondatabase/serverless");
const { google } = require("googleapis");

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

async function ensureTables() {
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS sepay_transactions (
      id VARCHAR(100) PRIMARY KEY,
      purchase_code VARCHAR(30),
      reference_code VARCHAR(200),
      amount BIGINT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_content TEXT`;
  await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) NOT NULL DEFAULT 'drive'`;
  await sql`ALTER TABLE sepay_transactions ADD COLUMN IF NOT EXISTS match_status VARCHAR(30) NOT NULL DEFAULT 'received'`;
}

function validAuth(headers) {
  const key = String(process.env.SEPAY_API_KEY || "").trim();
  if (!key) return true;
  const auth = String(headers.authorization || headers.Authorization || "").trim();
  return auth === `Apikey ${key}`;
}

function purchaseCodeFrom(payload) {
  const text = [payload.content, payload.code, payload.description, payload.referenceCode].map(x => String(x || "")).join(" ");
  return (text.match(/\bNIX[A-Z0-9]{6,12}\b/i)?.[0] || "").toUpperCase();
}

async function grantDriveAccess(order) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Chua cau hinh GOOGLE_SERVICE_ACCOUNT_JSON");
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive"] });
  const drive = google.drive({ version: "v3", auth });
  const folderValue = String(order.drive_folder_id || "").trim();
  const folderId = folderValue.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1] || folderValue;
  const response = await drive.permissions.create({
    fileId: folderId,
    sendNotificationEmail: true,
    emailMessage: `Bạn đã được cấp quyền truy cập khóa học ${order.course_title} từ Nixart.`,
    requestBody: { type: "user", role: "reader", emailAddress: order.email },
    fields: "id"
  });
  return response.data.id || "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { success: false, error: "method_not_allowed" });
  if (!validAuth(event.headers || {})) return json(401, { success: false, error: "unauthorized" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { success: false, error: "bad_json" }); }

  const transactionId = String(payload.id || payload.referenceCode || "").slice(0, 100);
  const amount = Math.max(0, parseInt(payload.transferAmount, 10) || 0);
  const transferType = String(payload.transferType || "").toLowerCase();
  const purchaseCode = purchaseCodeFrom(payload);
  if (!transactionId || transferType !== "in" || !amount || !purchaseCode) return json(200, { success: true, ignored: true });

  try {
    const sql = db();
    await ensureTables();
    const inserted = await sql`
      INSERT INTO sepay_transactions (id, purchase_code, reference_code, amount, payload)
      VALUES (${transactionId}, ${purchaseCode}, ${String(payload.referenceCode || "")}, ${amount}, ${JSON.stringify(payload)})
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    const duplicate = !inserted.length;

    const claimed = await sql`
      UPDATE purchase_orders
      SET status = 'processing', transfer_reference = ${String(payload.referenceCode || payload.description || "")}
      WHERE purchase_code = ${purchaseCode} AND status IN ('pending', 'paid') AND amount = ${amount}
      RETURNING id, course_title, drive_folder_id, email, delivery_type
    `;
    const order = claimed[0];
    if (!order) {
      if (duplicate) return json(200, { success: true, duplicate: true });
      await sql`UPDATE sepay_transactions SET match_status = 'unmatched' WHERE id = ${transactionId}`;
      return json(200, { success: true, unmatched: true });
    }

    if (order.delivery_type === "manual") {
      await sql`UPDATE purchase_orders SET status = 'paid', reviewed_at = NOW() WHERE id = ${order.id}`;
      await sql`UPDATE sepay_transactions SET match_status = 'paid' WHERE id = ${transactionId}`;
      return json(200, { success: true, status: "paid" });
    }

    try {
      const permissionId = await grantDriveAccess(order);
      await sql`
        UPDATE purchase_orders
        SET status = 'approved', drive_permission_id = ${permissionId}, reviewed_at = NOW()
        WHERE id = ${order.id}
      `;
      await sql`UPDATE sepay_transactions SET match_status = 'approved' WHERE id = ${transactionId}`;
      return json(200, { success: true, status: "approved" });
    } catch (error) {
      await sql`UPDATE purchase_orders SET status = 'paid' WHERE id = ${order.id}`;
      await sql`UPDATE sepay_transactions SET match_status = 'drive_failed' WHERE id = ${transactionId}`;
      console.error("sepay drive grant error", error);
      return json(200, { success: true, status: "paid", delivery: "drive_failed" });
    }
  } catch (error) {
    console.error("sepay webhook error", error);
    return json(500, { success: false, error: "server_error" });
  }
};
