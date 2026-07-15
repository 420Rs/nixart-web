const { ChannelType, REST, Routes } = require("discord.js");
const { DELIVERY_MODES, driveFolderId, effectiveDeliveryMode, getCatalog, isCourseContentReady, isForumCourseSaleReady } = require("../learning");

const DEFAULT_CHANNEL_ID = "1526640814472691804";
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const DELIVERY_TAG_NAMES = DELIVERY_MODES;

function truncateText(value, limit) {
  return Array.from(String(value || "").normalize("NFC")).slice(0, limit).join("");
}

function threadName(course) {
  const normalized = String(course?.title || course?.name || course?.id || "Khóa học").replace(/\s+/g, " ").trim();
  return truncateText(normalized, 100);
}

function stripLinks(value) {
  return String(value || "")
    .replace(/\[([^\]]+)]\((?:https?:\/\/|www\.)[^)]+\)/gi, "$1")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHttpsUrl(value, maxLength = 2000) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > maxLength) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return "";
    return url.href.length <= maxLength ? url.href : "";
  } catch {
    return "";
  }
}

function visibleCourses(catalog) {
  return Array.isArray(catalog?.courses) ? catalog.courses.filter(course => course?.forumVisible === true) : [];
}

function validateCatalogForSync(catalog) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.courses) || !catalog.courses.length) {
    throw new Error("Catalog phải có ít nhất một khóa học; dừng sync để tránh lưu trữ nhầm toàn bộ bài Discord");
  }
  const ids = new Set();
  for (const course of catalog.courses) {
    if (!course || typeof course !== "object" || Array.isArray(course)) throw new Error("Course trong catalog không hợp lệ");
    const id = String(course.id || "");
    if (!ID_RE.test(id) || ids.has(id.toLowerCase())) throw new Error(`Mã khóa học trùng hoặc không hợp lệ: ${id || "(trống)"}`);
    ids.add(id.toLowerCase());
    if (typeof course.title !== "string" || !course.title.trim() || Array.from(course.title).length > 256) {
      throw new Error(`Tên khóa học không hợp lệ: ${id}`);
    }
    if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(course.title)) throw new Error(`Tên khóa học chứa ký tự điều khiển: ${id}`);
    if (typeof course.description !== "string" || Array.from(course.description).length > 10000) {
      throw new Error(`Mô tả khóa học không hợp lệ: ${id}`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(course.description)) {
      throw new Error(`Mô tả khóa học chứa ký tự điều khiển: ${id}`);
    }
    if (!Number.isSafeInteger(course.price) || course.price < 0 || course.price > 2_000_000_000) {
      throw new Error(`Giá khóa học không hợp lệ: ${id}`);
    }
    if (!["basic", "full"].includes(course.planTier)) throw new Error(`Gói khóa học không hợp lệ: ${id}`);
    for (const field of ["forumVisible", "published", "rightsVerified", "streamAvailable", "saleEnabled"]) {
      if (typeof course[field] !== "boolean") throw new Error(`${field} phải là boolean ở khóa học: ${id}`);
    }
    if (course.freeAccess !== undefined && typeof course.freeAccess !== "boolean") throw new Error(`freeAccess must be boolean: ${id}`);
    if (course.freeAccess === true && course.saleEnabled === true) throw new Error(`Free course cannot also accept payment: ${id}`);
    if (course.deliveryMode !== undefined && !DELIVERY_MODES.includes(course.deliveryMode)) {
      throw new Error(`deliveryMode không hợp lệ ở khóa học: ${id}`);
    }
    if (course.deliveryMode !== undefined && course.streamAvailable !== (course.deliveryMode === "STREAM")) {
      throw new Error(`streamAvailable không khớp deliveryMode ở khóa học: ${id}`);
    }
    if (course.driveFolderId !== undefined && (typeof course.driveFolderId !== "string" || course.driveFolderId.length > 300
        || (course.driveFolderId && !driveFolderId(course.driveFolderId)))) {
      throw new Error(`driveFolderId không hợp lệ ở khóa học: ${id}`);
    }
    if (!Array.isArray(course.lessons)) throw new Error(`Danh sách bài học không hợp lệ: ${id}`);
    const lessonIds = new Set();
    for (const lesson of course.lessons) {
      if (!lesson || typeof lesson !== "object" || Array.isArray(lesson) || !ID_RE.test(lesson.id)
          || lessonIds.has(lesson.id) || typeof lesson.title !== "string" || !lesson.title.trim()
          || typeof lesson.published !== "boolean") {
        throw new Error(`Bài học không hợp lệ hoặc trùng mã ở khóa học: ${id}`);
      }
      lessonIds.add(lesson.id);
    }
    if (course.imageUrl && !safeHttpsUrl(course.imageUrl, 2000)) throw new Error(`imageUrl phải là URL HTTPS hợp lệ ở khóa học: ${id}`);
    if (course.previewUrl && !safeHttpsUrl(course.previewUrl, 512)) throw new Error(`previewUrl phải là URL HTTPS hợp lệ, tối đa 512 ký tự ở khóa học: ${id}`);
  }
  if (!catalog.courses.some(course => course.forumVisible)) {
    throw new Error("Không có khóa học nào được đăng forum; dừng sync để tránh lưu trữ nhầm toàn bộ bài Discord");
  }
  return catalog;
}

function paymentButton(course) {
  const id = String(course?.id || "").trim();
  const freeEnabled = course?.forumVisible === true && course?.freeAccess === true && isCourseContentReady(course);
  const customId = `${freeEnabled ? "free_course" : "buy_course"}:${id}`;
  if (!id || customId.length > 100) throw new Error(`Course id không hợp lệ cho Discord button: ${id || "(trống)"}`);

  if (freeEnabled) return { type: 2, style: 3, label: "Học miễn phí", custom_id: customId, disabled: false };
  const enabled = isForumCourseSaleReady(course);
  return {
    type: 2,
    style: enabled ? 1 : 2,
    label: enabled ? "Thanh toán" : "Thanh toán — chưa mở",
    custom_id: customId,
    disabled: !enabled,
  };
}

function previewButton(course) {
  if (course?.rightsVerified !== true) return null;
  const url = safeHttpsUrl(course?.previewUrl, 512);
  return url ? { type: 2, style: 5, label: "Xem trước", url } : null;
}

function deliveryTagName(course) {
  return effectiveDeliveryMode(course);
}

function publishedLessonCount(course) {
  return Array.isArray(course?.lessons)
    ? course.lessons.filter(lesson => lesson?.published === true).length
    : 0;
}

function deliveryTagIds(channel) {
  const tags = Array.isArray(channel?.available_tags) ? channel.available_tags : [];
  return Object.fromEntries(DELIVERY_TAG_NAMES.map(name => {
    const tag = tags.find(item => String(item?.name || "").toUpperCase() === name);
    return [name, tag?.id || ""];
  }));
}

async function ensureDeliveryTags(rest, channel) {
  let ids = deliveryTagIds(channel);
  const missing = DELIVERY_TAG_NAMES.filter(name => !ids[name]);
  if (!missing.length) return ids;
  const current = Array.isArray(channel.available_tags) ? channel.available_tags : [];
  if (current.length + missing.length > 20) throw new Error("Forum đã đạt giới hạn 20 tag");
  const availableTags = [
    ...current.map(tag => ({
      id: tag.id,
      name: tag.name,
      moderated: tag.moderated === true,
      emoji_id: tag.emoji_id || null,
      emoji_name: tag.emoji_name || null,
    })),
    ...missing.map(name => ({ name, moderated: false })),
  ];
  const updated = await rest.patch(Routes.channel(channel.id), { body: { available_tags: availableTags } });
  ids = deliveryTagIds(updated);
  if (DELIVERY_TAG_NAMES.some(name => !ids[name])) throw new Error("Discord không trả về đủ tag DRIVE/STREAM/NON-STREAM");
  return ids;
}

function mergeAppliedDeliveryTag(appliedTags, tagIds, course) {
  const managed = new Set(DELIVERY_TAG_NAMES.map(name => tagIds?.[name]).filter(Boolean));
  const kept = (Array.isArray(appliedTags) ? appliedTags : []).filter(id => !managed.has(id));
  const desired = tagIds?.[deliveryTagName(course)];
  if (!desired) return kept;
  if (kept.length >= 5) throw new Error(`Bài ${course.id} đã có đủ 5 tag; không thể thêm ${deliveryTagName(course)}`);
  return [...kept, desired];
}

function buildForumPost(course, tagIds = {}) {
  const name = threadName(course);
  const description = truncateText(stripLinks(course?.description) || "Thông tin khóa học sẽ được cập nhật.", 4096);
  const lessonCount = effectiveDeliveryMode(course) === "STREAM" ? publishedLessonCount(course) : 0;
  const price = Number(course?.price);
  const saleReady = isForumCourseSaleReady(course);
  const freeReady = course?.forumVisible === true && course?.freeAccess === true && isCourseContentReady(course);
  const embed = {
    title: truncateText(name, 256),
    description,
    color: 0x2a2a2e,
    fields: [
      { name: "Trạng thái", value: saleReady ? "Đang mở bán" : "Chưa mở bán", inline: true },
      { name: "Hình thức", value: deliveryTagName(course), inline: true },
      { name: "Số bài học", value: String(lessonCount), inline: true },
      { name: "Giá", value: saleReady && Number.isFinite(price) ? `${new Intl.NumberFormat("vi-VN").format(price)}đ` : "Đang cập nhật", inline: true },
    ],
    footer: { text: truncateText(`Mã khóa học: ${course.id}`, 2048) },
  };
  const imageUrl = safeHttpsUrl(course?.imageUrl, 2000);
  if (freeReady) {
    embed.fields[0].value = "Đang chia sẻ miễn phí";
    embed.fields[3].value = "Miễn phí";
  }
  if (course?.rightsVerified === true && imageUrl) embed.image = { url: imageUrl };
  const components = [paymentButton(course)];
  const preview = previewButton(course);
  if (preview) components.push(preview);

  const post = {
    name,
    message: {
      embeds: [embed],
      components: [{ type: 1, components }],
      allowed_mentions: { parse: [] },
    },
  };
  const appliedTags = mergeAppliedDeliveryTag([], tagIds, course);
  if (appliedTags.length) post.applied_tags = appliedTags;
  return post;
}

function buildHiddenForumMessage(courseId, title) {
  const post = buildForumPost({
    id: courseId,
    title,
    description: "Khóa học này đã được ẩn khỏi danh mục Nixart.",
    published: false,
    rightsVerified: false,
    price: 0,
    lessons: [],
  });
  post.message.embeds[0].fields = [{ name: "Trạng thái", value: "Đã ẩn khỏi danh mục", inline: false }];
  return post.message;
}

function existingThreadNames(activeThreads, archivedThreads, channelId) {
  return new Set([...activeThreads, ...archivedThreads]
    .filter(thread => thread?.parent_id === channelId)
    .map(thread => threadName(thread)));
}

function courseIdFromMessage(message) {
  const footer = String(message?.embeds?.[0]?.footer?.text || "");
  const match = /^Mã khóa học:\s*([a-z0-9][a-z0-9_-]{0,79})$/i.exec(footer);
  return match ? match[1].toLowerCase() : "";
}

async function indexExistingThreads(rest, threads, channelId, botUserId) {
  const byId = new Map();
  for (const thread of threads.filter(item => item?.parent_id === channelId)) {
    try {
      const starter = await rest.get(Routes.channelMessage(thread.id, thread.id));
      if (starter?.author?.id !== botUserId) continue;
      const courseId = courseIdFromMessage(starter);
      if (courseId) byId.set(courseId, thread);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return byId;
}

async function getArchivedThreads(rest, channelId) {
  const threads = [];
  let before;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const page = await rest.get(Routes.channelThreads(channelId, "public"), { query });
    threads.push(...(page.threads || []));
    if (!page.has_more) break;
    const next = page.threads?.at(-1)?.thread_metadata?.archive_timestamp;
    if (!next || next === before) throw new Error("Discord không trả cursor cho danh sách thread đã lưu trữ");
    before = next;
  } while (true);
  return threads;
}

async function deleteForumCoursePost(courseId, channelId, token, rest) {
  if (!ID_RE.test(String(courseId || ""))) throw new Error("Mã khóa học cần xóa không hợp lệ");
  rest ||= new REST({ version: "10" }).setToken(token);
  const [channel, botUser] = await Promise.all([
    rest.get(Routes.channel(channelId)),
    rest.get("/users/@me"),
  ]);
  if (channel.type !== ChannelType.GuildForum || !channel.guild_id) {
    throw new Error(`Channel ${channelId} không phải GuildForum`);
  }
  const [active, archived] = await Promise.all([
    rest.get(Routes.guildActiveThreads(channel.guild_id)),
    getArchivedThreads(rest, channelId),
  ]);
  const existing = await indexExistingThreads(rest, [...(active.threads || []), ...archived], channelId, botUser.id);
  const thread = existing.get(courseId);
  if (!thread) {
    throw new Error(`Không tìm thấy bài Discord do bot tạo cho khóa ${courseId}; chưa xóa catalog`);
  }
  await rest.delete(Routes.channel(thread.id));
  console.log(`DELETED ${thread.name}`);
  return true;
}

async function publish(courses, channelId, token) {
  const rest = new REST({ version: "10" }).setToken(token);
  const [channel, botUser] = await Promise.all([
    rest.get(Routes.channel(channelId)),
    rest.get("/users/@me"),
  ]);
  if (channel.type !== ChannelType.GuildForum || !channel.guild_id) {
    throw new Error(`Channel ${channelId} không phải GuildForum`);
  }
  const tagIds = await ensureDeliveryTags(rest, channel);

  const [active, archived] = await Promise.all([
    rest.get(Routes.guildActiveThreads(channel.guild_id)),
    getArchivedThreads(rest, channelId),
  ]);
  const threads = [...(active.threads || []), ...archived];
  const existing = await indexExistingThreads(rest, threads, channelId, botUser.id);
  const desiredIds = new Set(courses.map(course => course.id));

  for (const course of courses) {
    const post = buildForumPost(course, tagIds);
    const thread = existing.get(course.id);
    if (thread) {
      const channelUpdate = {};
      if (thread.name !== post.name) channelUpdate.name = post.name;
      if (thread.thread_metadata?.archived) channelUpdate.archived = false;
      const appliedTags = mergeAppliedDeliveryTag(thread.applied_tags, tagIds, course);
      if (JSON.stringify(appliedTags) !== JSON.stringify(thread.applied_tags || [])) channelUpdate.applied_tags = appliedTags;
      if (Object.keys(channelUpdate).length) {
        await rest.patch(Routes.channel(thread.id), { body: channelUpdate });
      }
      await rest.patch(Routes.channelMessage(thread.id, thread.id), { body: post.message });
      existing.set(course.id, thread);
      console.log(`UPDATED ${post.name}`);
      continue;
    }
    const created = await rest.post(Routes.threads(channelId), { body: post });
    existing.set(course.id, created);
    console.log(`CREATED ${post.name}`);
  }

  for (const [courseId, thread] of existing) {
    if (desiredIds.has(courseId)) continue;
    if (thread.thread_metadata?.archived) {
      await rest.patch(Routes.channel(thread.id), { body: { archived: false } });
    }
    await rest.patch(Routes.channelMessage(thread.id, thread.id), {
      body: buildHiddenForumMessage(courseId, thread.name),
    });
    await rest.patch(Routes.channel(thread.id), { body: { archived: true } });
    console.log(`ARCHIVED ${thread.name}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--delete-course") {
    if (args.length !== 2 || !ID_RE.test(args[1])) throw new Error("Dùng --delete-course <course-id>");
    if (!process.env.DISCORD_BOT_TOKEN) throw new Error("Thiếu DISCORD_BOT_TOKEN; chưa xóa nội dung nào");
    await deleteForumCoursePost(
      args[1],
      process.env.DISCORD_COURSE_CHANNEL_ID || DEFAULT_CHANNEL_ID,
      process.env.DISCORD_BOT_TOKEN,
    );
    return;
  }
  const publishMode = args.includes("--publish");
  const unknown = args.filter(arg => arg !== "--publish" && arg !== "--dry-run");
  if (unknown.length || (publishMode && args.includes("--dry-run"))) throw new Error("Dùng mặc định/--dry-run hoặc --publish");

  const catalog = validateCatalogForSync(getCatalog());
  const courses = visibleCourses(catalog);
  const channelId = process.env.DISCORD_COURSE_CHANNEL_ID || DEFAULT_CHANNEL_ID;

  if (!publishMode) {
    console.log(JSON.stringify({ mode: "dry-run", channelId, posts: courses.map(buildForumPost) }, null, 2));
    return;
  }
  if (!process.env.DISCORD_BOT_TOKEN) throw new Error("Thiếu DISCORD_BOT_TOKEN; chưa gửi nội dung nào");
  await publish(courses, channelId, process.env.DISCORD_BOT_TOKEN);
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = {
  DEFAULT_CHANNEL_ID,
  buildForumPost,
  buildHiddenForumMessage,
  courseIdFromMessage,
  deleteForumCoursePost,
  existingThreadNames,
  indexExistingThreads,
  deliveryTagIds,
  deliveryTagName,
  ensureDeliveryTags,
  mergeAppliedDeliveryTag,
  paymentButton,
  previewButton,
  safeHttpsUrl,
  stripLinks,
  threadName,
  validateCatalogForSync,
  visibleCourses,
};
