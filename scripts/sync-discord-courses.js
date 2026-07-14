const fs = require("node:fs");
const path = require("node:path");
const { ChannelType, REST, Routes } = require("discord.js");
const { isForumCourseSaleReady } = require("../learning");

const DEFAULT_CHANNEL_ID = "1526640814472691804";

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

function visibleCourses(catalog) {
  return Array.isArray(catalog?.courses) ? catalog.courses.filter(course => course?.forumVisible === true) : [];
}

function paymentButton(course) {
  const id = String(course?.id || "").trim();
  const customId = `buy_course:${id}`;
  if (!id || customId.length > 100) throw new Error(`Course id không hợp lệ cho Discord button: ${id || "(trống)"}`);

  const enabled = isForumCourseSaleReady(course);
  return {
    type: 2,
    style: enabled ? 1 : 2,
    label: enabled ? "Thanh toán" : "Thanh toán — chưa mở",
    custom_id: customId,
    disabled: !enabled,
  };
}

function buildForumPost(course) {
  const name = threadName(course);
  const description = truncateText(stripLinks(course?.description) || "Thông tin khóa học sẽ được cập nhật.", 4096);
  const lessonCount = Array.isArray(course?.lessons) ? course.lessons.length : 0;
  const price = Number(course?.price);
  const saleReady = isForumCourseSaleReady(course);

  return {
    name,
    message: {
      embeds: [{
        title: truncateText(name, 256),
        description,
        color: 0x2a2a2e,
        fields: [
          { name: "Trạng thái", value: saleReady ? "Đang mở bán" : "Chưa mở bán", inline: true },
          { name: "Số bài học", value: String(lessonCount), inline: true },
          { name: "Giá", value: saleReady && Number.isFinite(price) ? `${new Intl.NumberFormat("vi-VN").format(price)}đ` : "Đang cập nhật", inline: true },
        ],
        footer: { text: truncateText(`Mã khóa học: ${course.id}`, 2048) },
      }],
      components: [{ type: 1, components: [paymentButton(course)] }],
      allowed_mentions: { parse: [] },
    },
  };
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

async function publish(courses, channelId, token) {
  const rest = new REST({ version: "10" }).setToken(token);
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
  const threads = [...(active.threads || []), ...archived];
  const existing = await indexExistingThreads(rest, threads, channelId, botUser.id);
  const desiredIds = new Set(courses.map(course => course.id));

  for (const course of courses) {
    const post = buildForumPost(course);
    const thread = existing.get(course.id);
    if (thread) {
      const channelUpdate = {};
      if (thread.name !== post.name) channelUpdate.name = post.name;
      if (thread.thread_metadata?.archived) channelUpdate.archived = false;
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
  const publishMode = args.includes("--publish");
  const unknown = args.filter(arg => arg !== "--publish" && arg !== "--dry-run");
  if (unknown.length || (publishMode && args.includes("--dry-run"))) throw new Error("Dùng mặc định/--dry-run hoặc --publish");

  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "content", "catalog.json"), "utf8"));
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
  existingThreadNames,
  indexExistingThreads,
  paymentButton,
  stripLinks,
  threadName,
  visibleCourses,
};
