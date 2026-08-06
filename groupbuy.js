const crypto = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const { ensureLearningTables, paymentQr } = require("./learning");

const DEFAULT_GROUPBUY_CHANNEL_ID = "1534754527671091270";
const GROUPBUY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
let sqlClient;
let tablesReady;

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function safeHttpsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2000 ? url.href : "";
  } catch {
    return "";
  }
}

function campaignId(title) {
  const slug = String(title || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 60) || "groupbuy";
  return `${slug}-${crypto.randomBytes(2).toString("hex")}`;
}

async function ensureGroupBuyTables(sqlOverride) {
  if (sqlOverride) return ensureTables(sqlOverride);
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    await ensureLearningTables();
    await ensureTables(db());
  })().catch(error => {
    tablesReady = null;
    throw error;
  });
  return tablesReady;
}

async function ensureTables(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS groupbuy_campaigns (
      id VARCHAR(80) PRIMARY KEY,
      title VARCHAR(256) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      course_url TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      preview_url TEXT NOT NULL DEFAULT '',
      total_price BIGINT NOT NULL,
      target_slots INT NOT NULL,
      reserved_slots INT NOT NULL DEFAULT 0,
      exclusive_reserved BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      channel_id VARCHAR(32) NOT NULL,
      message_id VARCHAR(32),
      created_by VARCHAR(32) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE groupbuy_campaigns ADD COLUMN IF NOT EXISTS course_url TEXT NOT NULL DEFAULT ''`;
  await sql`DROP INDEX IF EXISTS purchase_orders_one_active_groupbuy_user_idx`;
  await sql`DROP INDEX IF EXISTS purchase_orders_one_active_groupbuy_user_v2_idx`;
  await sql`
    UPDATE purchase_orders SET status = 'expired'
    WHERE delivery_type = 'groupbuy' AND access_scope = 'groupbuy_test' AND status = 'pending'
  `;
}

function normalizeCampaign(row) {
  if (!row) return null;
  const totalPrice = Number(row.total_price);
  const targetSlots = Number(row.target_slots);
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    courseUrl: row.course_url || "",
    imageUrl: row.image_url || "",
    previewUrl: row.preview_url || "",
    totalPrice,
    targetSlots,
    sharePrice: Math.floor(totalPrice / targetSlots),
    reservedSlots: Number(row.reserved_slots || 0),
    paidSlots: Number(row.paid_slots || 0),
    exclusivePaid: row.exclusive_paid === true,
    exclusiveReserved: row.exclusive_reserved === true,
    status: row.status,
    channelId: row.channel_id,
    messageId: row.message_id || ""
  };
}

async function getGroupBuyCampaign(id, sqlOverride) {
  const campaign = String(id || "").trim().toLowerCase();
  if (!GROUPBUY_ID_RE.test(campaign)) return null;
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  const rows = await sql`
    SELECT campaign.*,
      (SELECT COUNT(*) FROM purchase_orders purchase
       WHERE purchase.course_id = campaign.id AND purchase.delivery_type = 'groupbuy'
         AND purchase.access_scope = 'groupbuy_share' AND purchase.status = 'approved') AS paid_slots,
      EXISTS (SELECT 1 FROM purchase_orders purchase
       WHERE purchase.course_id = campaign.id AND purchase.delivery_type = 'groupbuy'
         AND purchase.access_scope = 'groupbuy_exclusive' AND purchase.status = 'approved') AS exclusive_paid
    FROM groupbuy_campaigns campaign
    WHERE campaign.id = ${campaign}
    LIMIT 1
  `;
  return normalizeCampaign(rows[0]);
}

async function listGroupBuyCampaigns(sqlOverride) {
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  const rows = await sql`
    SELECT campaign.*,
      (SELECT COUNT(*) FROM purchase_orders purchase
       WHERE purchase.course_id = campaign.id AND purchase.delivery_type = 'groupbuy'
         AND purchase.access_scope = 'groupbuy_share' AND purchase.status = 'approved') AS paid_slots,
      EXISTS (SELECT 1 FROM purchase_orders purchase
       WHERE purchase.course_id = campaign.id AND purchase.delivery_type = 'groupbuy'
         AND purchase.access_scope = 'groupbuy_exclusive' AND purchase.status = 'approved') AS exclusive_paid
    FROM groupbuy_campaigns campaign
    ORDER BY campaign.created_at DESC
    LIMIT 500
  `;
  return rows.map(normalizeCampaign);
}

async function createGroupBuyCampaign(input, sqlOverride) {
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  const totalPrice = Number(input.totalPrice || 400000);
  const targetSlots = Number(input.targetSlots || 10);
  const channelId = String(input.channelId || DEFAULT_GROUPBUY_CHANNEL_ID);
  const createdBy = String(input.createdBy || "");
  const imageUrl = safeHttpsUrl(input.imageUrl);
  const previewUrl = safeHttpsUrl(input.previewUrl);
  const courseUrl = safeHttpsUrl(input.courseUrl);
  if (!title || title.length > 256 || description.length > 4000) throw new Error("Tiêu đề hoặc mô tả GroupBuy không hợp lệ");
  if (!Number.isSafeInteger(totalPrice) || totalPrice < 10000 || totalPrice > 2_000_000_000
      || !Number.isSafeInteger(targetSlots) || targetSlots < 2 || targetSlots > 100
      || totalPrice % targetSlots !== 0) throw new Error("Giá phải chia đều cho số người GroupBuy");
  if (!/^\d{15,25}$/.test(channelId) || !/^\d{15,25}$/.test(createdBy)) throw new Error("Discord ID không hợp lệ");
  if (input.imageUrl && !imageUrl) throw new Error("Link ảnh phải là HTTPS hợp lệ");
  if (input.previewUrl && !previewUrl) throw new Error("Link xem trước phải là HTTPS hợp lệ");
  if (input.courseUrl && !courseUrl) throw new Error("Link khóa học phải là HTTPS hợp lệ");
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  const id = campaignId(title);
  const rows = await sql`
    INSERT INTO groupbuy_campaigns (
      id, title, description, course_url, image_url, preview_url, total_price, target_slots, channel_id, created_by
    ) VALUES (
      ${id}, ${title}, ${description}, ${courseUrl}, ${imageUrl}, ${previewUrl}, ${totalPrice}, ${targetSlots}, ${channelId}, ${createdBy}
    )
    RETURNING *
  `;
  return normalizeCampaign({ ...rows[0], paid_slots: 0, exclusive_paid: false });
}

async function attachGroupBuyMessage(id, messageId, sqlOverride) {
  if (!/^\d{15,25}$/.test(String(messageId || ""))) throw new Error("Discord message ID không hợp lệ");
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  await sql`UPDATE groupbuy_campaigns SET message_id = ${String(messageId)}, updated_at = NOW() WHERE id = ${id}`;
}

async function attachGroupBuyPost(id, channelId, messageId, sqlOverride) {
  if (!/^\d{15,25}$/.test(String(channelId || ""))) throw new Error("Discord channel ID không hợp lệ");
  if (!/^\d{15,25}$/.test(String(messageId || ""))) throw new Error("Discord message ID không hợp lệ");
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  await sql`UPDATE groupbuy_campaigns SET channel_id = ${String(channelId)}, message_id = ${String(messageId)}, updated_at = NOW() WHERE id = ${id}`;
}

async function createGroupBuyPurchase({ campaignId: id, kind, discordId, displayName }, sqlOverride) {
  const campaignIdValue = String(id || "").trim().toLowerCase();
  const accessScope = kind === "exclusive" ? "groupbuy_exclusive" : kind === "share" ? "groupbuy_share" : "";
  if (!GROUPBUY_ID_RE.test(campaignIdValue) || !accessScope || !/^\d{15,25}$/.test(String(discordId || ""))) {
    throw new Error("Yêu cầu GroupBuy không hợp lệ");
  }
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  const reserved = kind === "exclusive"
    ? await sql`
        UPDATE groupbuy_campaigns SET exclusive_reserved = TRUE, updated_at = NOW()
        WHERE id = ${campaignIdValue} AND status = 'open' AND reserved_slots = 0 AND exclusive_reserved = FALSE
        RETURNING *
      `
    : await sql`
        UPDATE groupbuy_campaigns SET reserved_slots = reserved_slots + 1, updated_at = NOW()
        WHERE id = ${campaignIdValue} AND status = 'open' AND exclusive_reserved = FALSE
          AND reserved_slots < target_slots
        RETURNING *
      `;
  if (!reserved[0]) {
    const current = await getGroupBuyCampaign(campaignIdValue, sql);
    if (!current) throw new Error("Không tìm thấy GroupBuy này");
    if (current.exclusiveReserved || current.exclusivePaid) throw new Error("Khóa này đang được mua độc quyền");
    if (kind === "exclusive" && current.reservedSlots > 0) throw new Error("Đã có người góp nên không thể mua độc quyền");
    throw new Error("GroupBuy đã đủ người hoặc đã đóng");
  }

  const amount = kind === "exclusive"
    ? Number(reserved[0].total_price)
    : Math.floor(Number(reserved[0].total_price) / Number(reserved[0].target_slots));
  const purchaseCode = `NIX${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const tokenHash = crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
  const inserted = await sql`
    INSERT INTO purchase_orders (
      id, purchase_code, token_hash, course_id, course_title, drive_folder_id,
      email, payer_name, amount, delivery_type, discord_id, access_scope, order_origin
    ) VALUES (
      ${crypto.randomUUID()}, ${purchaseCode}, ${tokenHash}, ${campaignIdValue}, ${reserved[0].title}, '',
      ${`${discordId}@discord.invalid`}, ${String(displayName || discordId).slice(0, 200)}, ${amount},
      'groupbuy', ${String(discordId)}, ${accessScope}, 'discord'
    )
    RETURNING purchase_code, course_title, amount, access_scope, status
  `;
  if (!inserted[0]) {
    if (kind === "exclusive") {
      await sql`UPDATE groupbuy_campaigns SET exclusive_reserved = FALSE WHERE id = ${campaignIdValue}`;
    } else {
      await sql`UPDATE groupbuy_campaigns SET reserved_slots = GREATEST(0, reserved_slots - 1) WHERE id = ${campaignIdValue}`;
    }
    throw new Error("Không tạo được đơn GroupBuy");
  }
  const campaign = await getGroupBuyCampaign(campaignIdValue, sql);
  return orderResult(inserted[0], campaign, false, kind);
}

function orderResult(order, campaign, reused, kind) {
  return {
    purchaseCode: order.purchase_code,
    product: order.course_title,
    amount: Number(order.amount),
    bank: {
      bin: String(process.env.BANK_BIN || ""),
      account: String(process.env.BANK_ACCOUNT || ""),
      accountName: String(process.env.BANK_ACCOUNT_NAME || "")
    },
    qrUrl: paymentQr({ amount: Number(order.amount) }, order.purchase_code),
    reused,
    deliveryType: "groupbuy",
    scope: kind,
    campaign
  };
}

async function approveGroupBuyOrder(order, sqlOverride) {
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  const rows = await sql`
    UPDATE purchase_orders
    SET status = 'approved', paid_at = COALESCE(paid_at, NOW()), reviewed_at = NOW()
    WHERE id = ${order.id} AND delivery_type = 'groupbuy' AND status IN ('processing', 'paid')
    RETURNING id, course_id, course_title, discord_id, access_scope
  `;
  if (!rows[0]) throw new Error("Không thể xác nhận đơn GroupBuy");
  if (rows[0].access_scope === "groupbuy_exclusive") {
    await sql`UPDATE groupbuy_campaigns SET status = 'exclusive', updated_at = NOW() WHERE id = ${rows[0].course_id}`;
  } else {
    await sql`
      UPDATE groupbuy_campaigns campaign SET status = 'funded', updated_at = NOW()
      WHERE campaign.id = ${rows[0].course_id} AND campaign.status = 'open'
        AND (SELECT COUNT(*) FROM purchase_orders purchase
          WHERE purchase.course_id = campaign.id AND purchase.delivery_type = 'groupbuy'
            AND purchase.access_scope = 'groupbuy_share' AND purchase.status = 'approved') >= campaign.target_slots
    `;
  }
  return rows[0];
}

async function getPendingGroupBuyNotifications(sqlOverride) {
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  return sql`
    SELECT id, course_id, course_title, discord_id, access_scope
    FROM purchase_orders
    WHERE delivery_type = 'groupbuy' AND status = 'approved' AND order_origin = 'discord'
      AND discord_notified_at IS NULL AND paid_at >= NOW() - INTERVAL '24 hours'
    ORDER BY paid_at ASC LIMIT 50
  `;
}

async function markGroupBuyNotified(orderId, sqlOverride) {
  if (!/^[0-9a-f-]{36}$/i.test(String(orderId || ""))) throw new Error("Mã đơn GroupBuy không hợp lệ");
  if (!sqlOverride) await ensureGroupBuyTables();
  const sql = sqlOverride || db();
  await sql`
    UPDATE purchase_orders SET discord_notified_at = NOW()
    WHERE id = ${String(orderId)}::uuid AND delivery_type = 'groupbuy' AND status = 'approved'
      AND order_origin = 'discord' AND discord_notified_at IS NULL
  `;
}

module.exports = {
  DEFAULT_GROUPBUY_CHANNEL_ID,
  GROUPBUY_ID_RE,
  approveGroupBuyOrder,
  attachGroupBuyMessage,
  attachGroupBuyPost,
  createGroupBuyCampaign,
  createGroupBuyPurchase,
  ensureGroupBuyTables,
  getGroupBuyCampaign,
  getPendingGroupBuyNotifications,
  listGroupBuyCampaigns,
  markGroupBuyNotified,
  safeHttpsUrl
};
