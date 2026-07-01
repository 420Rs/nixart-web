const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { google } = require("googleapis");

const sql = neon(process.env.DATABASE_URL);

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function page(title, content, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
    },
    body: `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><style>
      body{margin:0;background:#100c08;color:#f3ead9;font:16px system-ui,sans-serif}.box{max-width:620px;margin:8vh auto;padding:28px;background:#1f1812;border:1px solid #3a2e1f;border-radius:12px}h1{color:#ffc46b}.row{padding:10px 0;border-bottom:1px solid #3a2e1f}.label{display:block;color:#9c8c74;font-size:12px;text-transform:uppercase}.actions{display:flex;gap:12px;margin-top:24px}button{padding:12px 18px;border:0;border-radius:7px;font-weight:700;cursor:pointer}.approve{background:#4ddb8e;color:#08210f}.reject{background:#ff4d3d;color:#fff}code{color:#ffc46b}p{line-height:1.55}</style></head><body><main class="box"><h1>${esc(title)}</h1>${content}</main></body></html>`
  };
}

async function grantDriveAccess(order) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Chua cau hinh GOOGLE_SERVICE_ACCOUNT_JSON");
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  const drive = google.drive({ version: "v3", auth });
  const folderValue = String(order.drive_folder_id || "").trim();
  const folderMatch = folderValue.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  const folderId = folderMatch ? folderMatch[1] : folderValue;
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(folderId)) throw Object.assign(new Error("Google Drive Folder ID khong hop le"), { code: 400 });
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
  const query = event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString();
  const params = event.httpMethod === "POST"
    ? new URLSearchParams(event.body || "")
    : new URLSearchParams(query);
  const token = params.get("token") || "";
  const tokenHash = hashToken(token);

  if (!/^[a-f0-9]{64}$/.test(token)) return page("Liên kết không hợp lệ", "<p>Token duyệt bị thiếu hoặc không hợp lệ.</p>", 400);

  try {
    if (event.httpMethod === "GET") {
      const rows = await sql`
        SELECT purchase_code, course_title, email, payer_name, transfer_reference, amount, status, created_at
        FROM purchase_orders WHERE token_hash = ${tokenHash} LIMIT 1
      `;
      const order = rows[0];
      if (!order) return page("Không tìm thấy đơn", "<p>Liên kết không tồn tại hoặc đã bị xóa.</p>", 404);
      if (order.status !== "pending") return page("Đơn đã được xử lý", `<p>Trạng thái hiện tại: <code>${esc(order.status)}</code>.</p>`);

      return page("Xác nhận thanh toán", `
        <div class="row"><span class="label">Khóa học</span>${esc(order.course_title)}</div>
        <div class="row"><span class="label">Số tiền cần nhận</span>${Number(order.amount).toLocaleString("vi-VN")} đ</div>
        <div class="row"><span class="label">Nội dung chuyển khoản</span><code>${esc(order.purchase_code)}</code></div>
        <div class="row"><span class="label">Email Google</span>${esc(order.email)}</div>
        <div class="row"><span class="label">Tên người chuyển</span>${esc(order.payer_name)}</div>
        <div class="row"><span class="label">Mã giao dịch</span>${esc(order.transfer_reference || "Không cung cấp")}</div>
        <p>Chỉ bấm chấp nhận sau khi đã kiểm tra tiền trong ứng dụng ngân hàng.</p>
        <form method="post" class="actions">
          <input type="hidden" name="token" value="${esc(token)}">
          <button class="approve" name="action" value="approve">Chấp nhận và cấp Drive</button>
          <button class="reject" name="action" value="reject">Từ chối</button>
        </form>`);
    }

    if (event.httpMethod !== "POST") return page("Không hỗ trợ", "<p>Phương thức không được hỗ trợ.</p>", 405);
    const action = params.get("action");
    if (!['approve', 'reject'].includes(action)) return page("Yêu cầu không hợp lệ", "<p>Hành động không hợp lệ.</p>", 400);

    const claimed = await sql`
      UPDATE purchase_orders SET status = 'processing'
      WHERE token_hash = ${tokenHash} AND status = 'pending'
      RETURNING id, course_title, drive_folder_id, email
    `;
    const order = claimed[0];
    if (!order) return page("Đơn đã được xử lý", "<p>Đơn này không còn ở trạng thái chờ duyệt.</p>", 409);

    if (action === "reject") {
      await sql`UPDATE purchase_orders SET status = 'rejected', reviewed_at = NOW() WHERE id = ${order.id}`;
      return page("Đã từ chối", "<p>Đơn đã bị từ chối và không có quyền Drive nào được cấp.</p>");
    }

    try {
      const permissionId = await grantDriveAccess(order);
      await sql`
        UPDATE purchase_orders
        SET status = 'approved', drive_permission_id = ${permissionId}, reviewed_at = NOW()
        WHERE id = ${order.id}
      `;
      return page("Đã cấp quyền", `<p><strong>${esc(order.email)}</strong> đã được thêm vào thư mục khóa học với quyền xem.</p>`);
    } catch (error) {
      await sql`UPDATE purchase_orders SET status = 'pending' WHERE id = ${order.id}`;
      console.error("drive permission error", error);
      const code = Number(error.code || error.response?.status || 0);
      let reason = "Kiểm tra GOOGLE_SERVICE_ACCOUNT_JSON trên Netlify.";
      if (code === 400) reason = "Google Drive Folder ID không hợp lệ. Hãy dùng ID nằm sau /folders/ trong URL.";
      if (code === 401) reason = "Khóa service account không hợp lệ hoặc đã bị thu hồi.";
      if (code === 403) reason = "Google Drive API chưa bật, hoặc service account chưa có quyền Editor và quyền chia sẻ thư mục.";
      if (code === 404) reason = "Không tìm thấy thư mục. Folder ID có thể sai hoặc thư mục chưa được chia sẻ cho service account.";
      return page("Cấp quyền thất bại", `<p>${esc(reason)}</p><p>Đơn vẫn ở trạng thái chờ. Sửa cấu hình rồi mở lại link Discord để thử lại.</p>`, 502);
    }
  } catch (error) {
    console.error("review error", error);
    return page("Có lỗi xảy ra", "<p>Không xử lý được đơn lúc này.</p>", 500);
  }
};
