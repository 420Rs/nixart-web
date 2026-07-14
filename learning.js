const crypto = require("crypto");
const fs = require("node:fs");
const path = require("node:path");
const { neon } = require("@neondatabase/serverless");

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const DELIVERY_MODES = Object.freeze(["DRIVE", "STREAM", "NON-STREAM"]);
const DRIVE_FOLDER_ID_RE = /^[a-zA-Z0-9_-]{10,200}$/;
const CATALOG_PATH = path.join(__dirname, "content", "catalog.json");
const DELIVERY_CONFIG_PATH = path.join(__dirname, "content", "delivery.private.json");
const EMPTY_CATALOG = Object.freeze({ name: "NIXART", tagline: "", discordUrl: "", plans: [], courses: [] });
let sqlClient;
let tablesReady;

function driveFolderId(value) {
  const raw = String(value || "").trim();
  if (DRIVE_FOLDER_ID_RE.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "drive.google.com" || url.username || url.password) return "";
    return url.pathname.match(/\/folders\/([a-zA-Z0-9_-]{10,200})(?:\/|$)/)?.[1] || "";
  } catch {
    return "";
  }
}

function courseDeliveryMode(course) {
  if (DELIVERY_MODES.includes(course?.deliveryMode)) return course.deliveryMode;
  return course?.streamAvailable === true ? "STREAM" : "NON-STREAM";
}

function validCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)
      || !Array.isArray(catalog.plans) || !Array.isArray(catalog.courses)
      || !catalog.plans.every(item => item && typeof item === "object" && !Array.isArray(item)
        && ID_RE.test(item.id) && typeof item.title === "string" && typeof item.description === "string"
        && Number.isSafeInteger(item.price) && item.price >= 0 && item.price <= 2_000_000_000
        && Number.isSafeInteger(item.durationDays) && item.durationDays >= 1 && item.durationDays <= 366
        && typeof item.published === "boolean" && Array.isArray(item.features)
        && item.features.every(feature => typeof feature === "string"))) return false;
  if (new Set(catalog.plans.map(item => item.id)).size !== catalog.plans.length) return false;
  const ids = new Set();
  return catalog.courses.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !ID_RE.test(item.id) || ids.has(item.id)) return false;
    ids.add(item.id);
    const lessonIds = new Set();
    return typeof item.title === "string" && Boolean(item.title.trim()) && Array.from(item.title).length <= 256
      && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(item.title)
      && typeof item.description === "string" && Array.from(item.description).length <= 10000
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(item.description)
      && Number.isSafeInteger(item.price) && item.price >= 0 && item.price <= 2_000_000_000
      && ["basic", "full"].includes(item.planTier)
      && ["published", "forumVisible", "rightsVerified", "streamAvailable", "saleEnabled"].every(field => typeof item[field] === "boolean")
      && (item.deliveryMode === undefined || DELIVERY_MODES.includes(item.deliveryMode))
      && (item.deliveryMode === undefined || item.streamAvailable === (item.deliveryMode === "STREAM"))
      // Folder IDs live in the ignored private delivery file, never in the public catalog.
      && (item.driveFolderId === undefined || item.driveFolderId === "")
      && (!item.imageUrl || Boolean(publicUrl(item.imageUrl, 2000)))
      && (!item.previewUrl || Boolean(publicUrl(item.previewUrl, 512)))
      && Array.isArray(item.lessons)
      && item.lessons.every(lesson => {
        if (!lesson || typeof lesson !== "object" || Array.isArray(lesson)
            || !ID_RE.test(lesson.id) || lessonIds.has(lesson.id)) return false;
        lessonIds.add(lesson.id);
        return typeof lesson.title === "string" && Boolean(lesson.title.trim()) && typeof lesson.published === "boolean"
          && (lesson.duration === undefined || typeof lesson.duration === "string");
      });
  });
}

function loadCatalog() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const before = fs.statSync(CATALOG_PATH);
      const source = fs.readFileSync(CATALOG_PATH);
      const after = fs.statSync(CATALOG_PATH);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || source.length !== after.size) continue;
      const next = JSON.parse(source.toString("utf8"));
      if (!validCatalog(next)) return EMPTY_CATALOG;
      const driveFolders = loadPrivateDriveFolders();
      return {
        ...next,
        courses: next.courses.map(course => ({
          ...course,
          driveFolderId: courseDeliveryMode(course) === "DRIVE" ? driveFolders[course.id] || "" : ""
        }))
      };
    } catch {
      // Retry one transient replace/read race, then fail closed for purchases and playback.
    }
  }
  return EMPTY_CATALOG;
}

function loadPrivateDriveFolders() {
  try {
    const source = fs.readFileSync(DELIVERY_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(String(source).replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || !parsed.driveFolders || typeof parsed.driveFolders !== "object" || Array.isArray(parsed.driveFolders)) return {};
    return Object.fromEntries(Object.entries(parsed.driveFolders)
      .filter(([courseId, folder]) => ID_RE.test(courseId) && Boolean(driveFolderId(folder)))
      .map(([courseId, folder]) => [courseId, driveFolderId(folder)]));
  } catch {
    return {};
  }
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function cleanId(value) {
  const id = String(value || "").trim().toLowerCase();
  return ID_RE.test(id) ? id : "";
}

function isCourseListed(course) {
  return Boolean(course?.published === true && course?.rightsVerified === true);
}

function hasPublishedLesson(course) {
  return Array.isArray(course?.lessons) && course.lessons.some(lesson =>
    lesson?.published === true && ID_RE.test(lesson.id) && typeof lesson.title === "string" && Boolean(lesson.title.trim()));
}

function isCourseContentReady(course) {
  return isCourseListed(course) && courseDeliveryMode(course) === "STREAM"
    && course?.streamAvailable === true && hasPublishedLesson(course);
}

function isDriveCourseReady(course) {
  return isCourseListed(course) && courseDeliveryMode(course) === "DRIVE" && Boolean(driveFolderId(course?.driveFolderId));
}

function effectiveDeliveryMode(course) {
  if (isDriveCourseReady(course)) return "DRIVE";
  if (isCourseContentReady(course)) return "STREAM";
  return "NON-STREAM";
}

function isCourseSaleReady(course) {
  return course?.saleEnabled === true && Number.isSafeInteger(course?.price) && course.price > 0
    && ["DRIVE", "STREAM"].includes(effectiveDeliveryMode(course));
}

function isForumCourseSaleReady(course) {
  return course?.forumVisible === true && isCourseSaleReady(course);
}

function getCatalog() {
  return loadCatalog();
}

function publicUrl(value, maxLength = 2000) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (!candidate || candidate.length > maxLength) return "";
  try {
    const url = new URL(candidate);
    const href = url.href;
    return url.protocol === "https:" && !url.username && !url.password && href.length <= maxLength ? href : "";
  } catch {
    return "";
  }
}

function publicCatalog() {
  const catalog = getCatalog();
  return {
    name: String(catalog.name || "NIXART"),
    tagline: String(catalog.tagline || ""),
    discordUrl: publicUrl(process.env.DISCORD_INVITE_URL || catalog.discordUrl),
    plans: catalog.plans.filter(item => item.published).map(item => ({
      id: String(item.id || ""),
      title: String(item.title || ""),
      price: Number(item.price) || 0,
      durationDays: Number(item.durationDays) || 0,
      description: String(item.description || ""),
      features: Array.isArray(item.features) ? item.features.map(feature => String(feature)) : []
    })),
    courses: catalog.courses.filter(isCourseListed).map(course => ({
      id: String(course.id || ""),
      title: String(course.title || ""),
      description: String(course.description || ""),
      price: Number(course.price) || 0,
      planTier: String(course.planTier || ""),
      deliveryMode: effectiveDeliveryMode(course),
      // Keep the old flag for landing clients deployed before deliveryMode.
      streamAvailable: effectiveDeliveryMode(course) === "STREAM",
      saleEnabled: isCourseSaleReady(course),
      imageUrl: publicUrl(course.imageUrl, 2000),
      previewUrl: publicUrl(course.previewUrl, 512),
      lessons: (effectiveDeliveryMode(course) === "STREAM" ? course.lessons || [] : []).filter(item => item.published).map(lesson => ({
        id: String(lesson.id || ""),
        title: String(lesson.title || ""),
        duration: String(lesson.duration || "")
      }))
    }))
  };
}

function findCourse(courseId) {
  const id = cleanId(courseId);
  return getCatalog().courses.find(course => isCourseContentReady(course) && course.id === id) || null;
}

function findSaleCourse(courseId) {
  const id = cleanId(courseId);
  return getCatalog().courses.find(course => isCourseSaleReady(course) && course.id === id) || null;
}

function findLesson(course, lessonId) {
  const id = cleanId(lessonId);
  return (course?.lessons || []).find(lesson => lesson.published && lesson.id === id) || null;
}

function findPlan(planId) {
  const id = cleanId(planId);
  return getCatalog().plans.find(plan => plan.published && plan.id === id) || null;
}

async function ensureLearningTables() {
  if (tablesReady) return tablesReady;
  const sql = db();
  tablesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id UUID PRIMARY KEY,
        purchase_code VARCHAR(30) UNIQUE NOT NULL,
        token_hash VARCHAR(64) UNIQUE NOT NULL,
        course_id VARCHAR(100) NOT NULL,
        course_title VARCHAR(300) NOT NULL,
        drive_folder_id VARCHAR(300) NOT NULL DEFAULT '',
        email VARCHAR(254) NOT NULL,
        payer_name VARCHAR(200) NOT NULL,
        transfer_reference VARCHAR(200) NOT NULL DEFAULT '',
        amount BIGINT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        drive_permission_id VARCHAR(300),
        delivery_type VARCHAR(20) NOT NULL DEFAULT 'drive',
        auth_user_id VARCHAR(100),
        delivery_content TEXT,
        discord_id VARCHAR(32),
        access_scope VARCHAR(20),
        access_days INT,
        access_expires_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        order_origin VARCHAR(20) NOT NULL DEFAULT 'web',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ
      )
    `;
    await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS discord_id VARCHAR(32)`;
    await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20)`;
    await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS access_days INT`;
    await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ`;
    await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
    await sql`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS order_origin VARCHAR(20) NOT NULL DEFAULT 'web'`;
    await sql`CREATE INDEX IF NOT EXISTS purchase_orders_discord_access_idx ON purchase_orders (discord_id, status, access_scope, access_expires_at)`;
    await sql`CREATE INDEX IF NOT EXISTS purchase_orders_status_idx ON purchase_orders (status, created_at DESC)`;
    await sql`
      UPDATE purchase_orders
      SET status = 'expired'
      WHERE delivery_type = 'hls' AND status = 'pending' AND created_at <= NOW() - INTERVAL '30 minutes'
    `;
    await sql`
      WITH duplicates AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY discord_id, course_id ORDER BY created_at DESC) AS position
        FROM purchase_orders
        WHERE delivery_type = 'hls' AND status = 'pending'
      )
      UPDATE purchase_orders
      SET status = 'expired'
      WHERE id IN (SELECT id FROM duplicates WHERE position > 1)
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_one_pending_hls_idx
      ON purchase_orders (discord_id, course_id)
      WHERE delivery_type = 'hls' AND status = 'pending'
    `;
    await sql`
      WITH duplicates AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY discord_id, course_id ORDER BY created_at DESC) AS position
        FROM purchase_orders
        WHERE delivery_type = 'drive' AND status = 'pending' AND discord_id IS NOT NULL
      )
      UPDATE purchase_orders
      SET status = 'expired'
      WHERE id IN (SELECT id FROM duplicates WHERE position > 1)
    `;
    await sql`
      DROP INDEX IF EXISTS purchase_orders_one_pending_drive_idx
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_one_active_drive_idx
      ON purchase_orders (discord_id, course_id)
      WHERE delivery_type = 'drive' AND order_origin = 'discord' AND discord_id IS NOT NULL
        AND status IN ('pending', 'processing', 'paid', 'approved')
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS learning_entitlements (
        discord_id VARCHAR(32) NOT NULL,
        access_scope VARCHAR(20) NOT NULL,
        course_id VARCHAR(100) NOT NULL DEFAULT '',
        expires_at TIMESTAMPTZ,
        last_order_id UUID UNIQUE NOT NULL REFERENCES purchase_orders(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (discord_id, access_scope, course_id)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS learning_entitlement_credits (
        order_id UUID PRIMARY KEY REFERENCES purchase_orders(id),
        credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      INSERT INTO learning_entitlements (discord_id, access_scope, course_id, expires_at, last_order_id)
      SELECT DISTINCT ON (discord_id, access_scope, CASE WHEN access_scope = 'course' THEN course_id ELSE '' END)
        discord_id,
        access_scope,
        CASE WHEN access_scope = 'course' THEN course_id ELSE '' END,
        access_expires_at,
        id
      FROM purchase_orders
      WHERE delivery_type = 'hls' AND status = 'approved' AND discord_id IS NOT NULL
        AND access_scope IN ('course', 'basic', 'full')
        AND (access_scope = 'course' OR access_expires_at IS NOT NULL)
      ORDER BY discord_id, access_scope, CASE WHEN access_scope = 'course' THEN course_id ELSE '' END,
               access_expires_at DESC NULLS LAST, created_at DESC
      ON CONFLICT (discord_id, access_scope, course_id) DO NOTHING
    `;
    await sql`
      INSERT INTO learning_entitlement_credits (order_id)
      SELECT id FROM purchase_orders
      WHERE delivery_type = 'hls' AND status = 'approved' AND discord_id IS NOT NULL
        AND access_scope IN ('course', 'basic', 'full')
      ON CONFLICT (order_id) DO NOTHING
    `;
  })().catch(error => {
    tablesReady = null;
    throw error;
  });
  return tablesReady;
}

function active(entitlement, now = Date.now()) {
  if (entitlement.access_scope === "course") {
    return !entitlement.access_expires_at || new Date(entitlement.access_expires_at).getTime() > now;
  }
  return Boolean(entitlement.access_expires_at) && new Date(entitlement.access_expires_at).getTime() > now;
}

function canAccessCourse(entitlements, course, now = Date.now()) {
  return entitlements.some(item => {
    if (!active(item, now)) return false;
    if (item.access_scope === "course") return item.course_id === course.id;
    if (item.access_scope === "full") return true;
    return item.access_scope === "basic" && course.planTier === "basic";
  });
}

async function getEntitlements(discordId) {
  if (!/^\d{15,25}$/.test(String(discordId || ""))) return [];
  await ensureLearningTables();
  const sql = db();
  return sql`
    SELECT course_id, access_scope, access_expires_at
    FROM (
      SELECT course_id, access_scope, expires_at AS access_expires_at, updated_at
      FROM learning_entitlements
      WHERE discord_id = ${String(discordId)}
    ) entitlements
    ORDER BY updated_at DESC
  `;
}

async function hasCourseAccess(discordId, course) {
  return canAccessCourse(await getEntitlements(discordId), course);
}

function productFor(scope, value) {
  if (scope === "course") {
    const course = findSaleCourse(value);
    if (!course) return null;
    const mode = effectiveDeliveryMode(course);
    return {
      id: course.id,
      title: course.title,
      amount: Number(course.price),
      scope: "course",
      days: null,
      deliveryType: mode === "DRIVE" ? "drive" : "hls",
      driveFolderId: mode === "DRIVE" ? driveFolderId(course.driveFolderId) : ""
    };
  }
  const plan = findPlan(scope);
  if (!plan || !["basic", "full"].includes(scope) || !Number(plan.price)) return null;
  return { id: `plan:${scope}`, title: plan.title, amount: Number(plan.price), scope, days: Number(plan.durationDays || 30), deliveryType: "hls", driveFolderId: "" };
}

function googleEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const atom = "[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}";
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const local = email.split("@", 1)[0];
  return email.length <= 254 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && new RegExp(`^${atom}@${label}(?:\\.${label})+$`, "i").test(email) ? email : "";
}

function escapeDiscordMarkdown(value) {
  return String(value || "").replace(/[\\`*_~|\[\]()]/g, "\\$&");
}

function driveReviewUrl(token) {
  try {
    const base = new URL(String(process.env.PUBLIC_BASE_URL || ""));
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !["", "/"].includes(base.pathname)) return "";
    return `${base.origin}/review?${new URLSearchParams({ token })}`;
  } catch {
    return "";
  }
}

async function notifyDriveReview({ token, product, purchaseCode, email }) {
  const webhook = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
  const reviewUrl = driveReviewUrl(token);
  if (!webhook || !reviewUrl) throw new Error("Thiếu DISCORD_WEBHOOK_URL hoặc PUBLIC_BASE_URL để dự phòng đơn Drive");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Nixart Orders",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "Đơn Google Drive mới",
        color: 0x5ec98a,
        fields: [
          { name: "Khóa học", value: escapeDiscordMarkdown(product.title).slice(0, 1024) },
          { name: "Mã đơn", value: purchaseCode, inline: true },
          { name: "Email Google", value: escapeDiscordMarkdown(email).slice(0, 1024) },
          { name: "Dự phòng / thử lại", value: `[Mở trang duyệt riêng](${reviewUrl})` }
        ]
      }]
    })
  });
  if (!response.ok) throw new Error(`Không gửi được link dự phòng Drive (${response.status})`);
}

function bankDetails() {
  return {
    bin: String(process.env.BANK_BIN || ""),
    account: String(process.env.BANK_ACCOUNT || ""),
    accountName: String(process.env.BANK_ACCOUNT_NAME || "")
  };
}

function paymentQr(product, purchaseCode) {
  const bank = bankDetails();
  if (!bank.bin || !bank.account) return "";
  const query = new URLSearchParams({
    amount: String(product.amount),
    addInfo: purchaseCode,
    accountName: bank.accountName
  });
  return `https://img.vietqr.io/image/${encodeURIComponent(bank.bin)}-${encodeURIComponent(bank.account)}-compact2.png?${query}`;
}

async function createPurchase({ discordId, displayName, scope, value, email = "" }) {
  if (!/^\d{15,25}$/.test(String(discordId || ""))) throw new Error("Discord user id không hợp lệ");
  const product = productFor(cleanId(scope), cleanId(value));
  if (!product) throw new Error("Sản phẩm chưa sẵn sàng");
  const normalizedEmail = product.deliveryType === "drive" ? googleEmail(email) : `${discordId}@discord.invalid`;
  if (product.deliveryType === "drive" && !normalizedEmail) throw new Error("Email Google không hợp lệ");
  await ensureLearningTables();
  const sql = db();
  if (product.scope === "course") {
    if (product.deliveryType === "hls") {
      const owned = await sql`
        SELECT 1 FROM learning_entitlements
        WHERE discord_id = ${String(discordId)} AND access_scope = 'course' AND course_id = ${product.id}
        LIMIT 1
      `;
      if (owned.length) throw new Error("Bạn đã sở hữu khóa học này");
    }
    const inFlight = await sql`
      SELECT 1 FROM purchase_orders
      WHERE discord_id = ${String(discordId)} AND course_id = ${product.id}
        AND delivery_type = ${product.deliveryType} AND access_scope = 'course'
        AND status IN ('processing', 'paid', 'approved')
      LIMIT 1
    `;
    if (inFlight.length) throw new Error("Khóa học này đã mua hoặc đang được xử lý");
  }
  await sql`
    UPDATE purchase_orders SET status = 'expired'
    WHERE discord_id = ${String(discordId)} AND course_id = ${product.id}
      AND delivery_type = ${product.deliveryType} AND status = 'pending'
      AND created_at <= NOW() - INTERVAL '30 minutes'
  `;
  let existing = await sql`
    SELECT id, purchase_code, course_title, amount, email, created_at
    FROM purchase_orders
    WHERE discord_id = ${String(discordId)} AND course_id = ${product.id}
      AND delivery_type = ${product.deliveryType} AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `;
  let reused = Boolean(existing.length);
  let created = false;
  let purchaseCode = existing[0]?.purchase_code || `NIX${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  if (!existing.length) {
    const inserted = await sql`
      INSERT INTO purchase_orders (
        id, purchase_code, token_hash, course_id, course_title, drive_folder_id,
        email, payer_name, amount, delivery_type, discord_id, access_scope,
        access_days, order_origin
      ) VALUES (
        ${crypto.randomUUID()}, ${purchaseCode}, ${tokenHash},
        ${product.id}, ${product.title}, ${product.driveFolderId}, ${normalizedEmail},
        ${String(displayName || discordId).slice(0, 200)}, ${product.amount}, ${product.deliveryType},
        ${String(discordId)}, ${product.scope}, ${product.days}, 'discord'
      )
      ON CONFLICT DO NOTHING
      RETURNING id, purchase_code, course_title, amount, email, status, created_at
    `;
    existing = inserted.length ? [] : await sql`
      SELECT id, purchase_code, course_title, amount, email, status, created_at
      FROM purchase_orders
      WHERE discord_id = ${String(discordId)} AND course_id = ${product.id}
        AND delivery_type = ${product.deliveryType}
        AND status IN ('pending', 'processing', 'paid', 'approved')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!inserted.length && existing[0]?.status !== "pending") {
      throw new Error("Khóa học này đã mua hoặc đang được xử lý");
    }
    if (!inserted.length && existing.length) {
      reused = true;
      purchaseCode = existing[0].purchase_code;
    }
    if (!inserted.length && !existing.length) throw new Error("Không tạo được đơn thanh toán");
    if (inserted.length) {
      created = true;
      purchaseCode = inserted[0].purchase_code;
    }
  }
  let orderEmail = "";
  if (product.deliveryType === "drive") {
    orderEmail = created ? normalizedEmail : googleEmail(existing[0]?.email);
    if (!orderEmail || orderEmail !== normalizedEmail) {
      const suffix = orderEmail ? ` với email ${orderEmail}` : "";
      throw new Error(`Bạn đã có đơn Drive đang chờ${suffix}. Hãy dùng đúng email đó hoặc đợi 30 phút để tạo lại.`);
    }
    if (created) {
      await notifyDriveReview({ token, product, purchaseCode, email: orderEmail })
        .catch(error => console.error("drive review notification error", error));
    }
  }
  return {
    purchaseCode,
    product: existing[0]?.course_title || product.title,
    amount: Number(existing[0]?.amount || product.amount),
    bank: bankDetails(),
    qrUrl: paymentQr({ ...product, amount: Number(existing[0]?.amount || product.amount) }, purchaseCode),
    reused,
    deliveryType: product.deliveryType,
    scope: product.scope,
    email: orderEmail
  };
}

async function approveHlsOrder(orderId, discordId, scope, days) {
  await ensureLearningTables();
  const sql = db();
  if (!/^\d{15,25}$/.test(String(discordId || "")) || !["course", "basic", "full"].includes(scope)) {
    throw new Error("Invalid HLS entitlement");
  }
  if (scope === "course") {
    const approved = await sql`
      WITH credit AS (
        INSERT INTO learning_entitlement_credits (order_id)
        SELECT id FROM purchase_orders
        WHERE id = ${orderId} AND delivery_type = 'hls'
          AND discord_id = ${String(discordId)} AND access_scope = 'course'
        ON CONFLICT (order_id) DO NOTHING
        RETURNING order_id
      ), granted AS (
        INSERT INTO learning_entitlements (discord_id, access_scope, course_id, expires_at, last_order_id)
        SELECT purchase.discord_id, 'course', purchase.course_id, NULL, purchase.id
        FROM purchase_orders purchase JOIN credit ON credit.order_id = purchase.id
        ON CONFLICT (discord_id, access_scope, course_id) DO UPDATE
        SET expires_at = NULL, last_order_id = EXCLUDED.last_order_id, updated_at = NOW()
        RETURNING expires_at
      ), resolved AS (
        SELECT expires_at FROM granted
        UNION ALL
        SELECT entitlement.expires_at
        FROM learning_entitlement_credits credited
        JOIN purchase_orders purchase ON purchase.id = credited.order_id
        JOIN learning_entitlements entitlement
          ON entitlement.discord_id = purchase.discord_id
         AND entitlement.access_scope = 'course'
         AND entitlement.course_id = purchase.course_id
        WHERE credited.order_id = ${orderId}
        LIMIT 1
      )
      UPDATE purchase_orders
      SET status = 'approved', paid_at = NOW(), reviewed_at = NOW(), access_expires_at = NULL
      WHERE id = ${orderId} AND delivery_type = 'hls' AND EXISTS (SELECT 1 FROM resolved)
      RETURNING id
    `;
    if (!approved.length) throw new Error("Could not grant course entitlement");
    return;
  }
  const safeDays = Math.max(1, Math.min(366, Number(days || 30)));
  const approved = await sql`
    WITH credit AS (
      INSERT INTO learning_entitlement_credits (order_id)
      SELECT id FROM purchase_orders
      WHERE id = ${orderId} AND delivery_type = 'hls'
        AND discord_id = ${String(discordId)} AND access_scope = ${scope}
      ON CONFLICT (order_id) DO NOTHING
      RETURNING order_id
    ), granted AS (
      INSERT INTO learning_entitlements (discord_id, access_scope, course_id, expires_at, last_order_id)
      SELECT purchase.discord_id, purchase.access_scope, '', NOW() + (${safeDays} * INTERVAL '1 day'), purchase.id
      FROM purchase_orders purchase JOIN credit ON credit.order_id = purchase.id
      ON CONFLICT (discord_id, access_scope, course_id) DO UPDATE
      SET expires_at = GREATEST(NOW(), COALESCE(learning_entitlements.expires_at, NOW())) + (${safeDays} * INTERVAL '1 day'),
          last_order_id = EXCLUDED.last_order_id,
          updated_at = NOW()
      RETURNING expires_at
    ), resolved AS (
      SELECT expires_at FROM granted
      UNION ALL
      SELECT entitlement.expires_at
      FROM learning_entitlement_credits credited
      JOIN purchase_orders purchase ON purchase.id = credited.order_id
      JOIN learning_entitlements entitlement
        ON entitlement.discord_id = purchase.discord_id
       AND entitlement.access_scope = purchase.access_scope
       AND entitlement.course_id = ''
      WHERE credited.order_id = ${orderId}
      LIMIT 1
    )
    UPDATE purchase_orders
    SET status = 'approved', paid_at = NOW(), reviewed_at = NOW(),
        access_expires_at = (SELECT expires_at FROM resolved)
    WHERE id = ${orderId} AND delivery_type = 'hls' AND EXISTS (SELECT 1 FROM resolved)
    RETURNING id
  `;
  if (!approved.length) throw new Error("Could not grant subscription entitlement");
}

module.exports = {
  DELIVERY_MODES,
  ID_RE,
  approveHlsOrder,
  canAccessCourse,
  cleanId,
  courseDeliveryMode,
  createPurchase,
  driveFolderId,
  effectiveDeliveryMode,
  escapeDiscordMarkdown,
  ensureLearningTables,
  findCourse,
  findLesson,
  findPlan,
  findSaleCourse,
  getCatalog,
  getEntitlements,
  googleEmail,
  hasPublishedLesson,
  hasCourseAccess,
  isCourseContentReady,
  isDriveCourseReady,
  isCourseListed,
  isCourseSaleReady,
  isForumCourseSaleReady,
  publicCatalog
};
