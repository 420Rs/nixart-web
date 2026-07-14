const {
  ActionRowBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require("discord.js");
const {
  createPurchase,
  findCourse,
  findLesson,
  getCatalog,
  hasCourseAccess
} = require("./learning");

let client;

function publishedCourses() {
  return (getCatalog().courses || []).filter(course => course.published);
}

function option(label, value, description) {
  return {
    label: String(label).slice(0, 100),
    value: String(value).slice(0, 100),
    description: String(description || "").slice(0, 100) || undefined
  };
}

function row(customId, placeholder, options) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      // ponytail: Discord limits one select to 25 options; add pagination only when the catalog reaches that size.
      .addOptions(options.slice(0, 25))
  );
}

function publicBaseUrl() {
  const raw = String(process.env.PUBLIC_BASE_URL || "");
  let url;
  try { url = new URL(raw); }
  catch (_) { throw new Error("PUBLIC_BASE_URL is required when the Discord bot is enabled"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("PUBLIC_BASE_URL must be a public HTTPS origin");
  }
  return url.origin;
}

function appUrl(courseId, lessonId) {
  const base = publicBaseUrl();
  const query = new URLSearchParams({ course: courseId, lesson: lessonId });
  return `${base}/learn?${query}`;
}

async function registerCommands(applicationId) {
  const commands = [
    new SlashCommandBuilder().setName("hoc").setDescription("Chọn khóa học và bài học để xem trên web"),
    new SlashCommandBuilder().setName("mua").setDescription("Mua lẻ khóa học hoặc đăng ký gói tháng")
  ].map(command => command.toJSON());
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
  const guildId = String(process.env.DISCORD_GUILD_ID || "");
  const route = guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId);
  await rest.put(route, { body: commands });
}

async function showCourses(interaction) {
  const courses = publishedCourses();
  if (!courses.length) {
    return interaction.reply({ content: "Chưa có khóa học nào được phát hành.", flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({
    content: "Chọn khóa học bạn muốn xem:",
    components: [row("learn_course", "Chọn khóa học", courses.map(course => option(course.title, course.id, course.description)))],
    flags: MessageFlags.Ephemeral
  });
}

async function showProducts(interaction) {
  const catalog = getCatalog();
  const plans = (catalog.plans || []).filter(plan => plan.published)
    .map(plan => option(`${plan.title} — ${Number(plan.price).toLocaleString("vi-VN")}đ`, `plan:${plan.id}`, `${plan.durationDays || 30} ngày`));
  const courses = publishedCourses().filter(course => Number(course.price) > 0)
    .map(course => option(`${course.title} — ${Number(course.price).toLocaleString("vi-VN")}đ`, `course:${course.id}`, "Sở hữu khóa học"));
  const products = [...plans, ...courses];
  if (!products.length) return interaction.reply({ content: "Chưa có sản phẩm nào đang bán.", flags: MessageFlags.Ephemeral });
  return interaction.reply({
    content: "Chọn hình thức thanh toán:",
    components: [row("buy_product", "Mua lẻ hoặc đăng ký tháng", products)],
    flags: MessageFlags.Ephemeral
  });
}

async function chooseCourse(interaction) {
  const course = findCourse(interaction.values[0]);
  const lessons = (course?.lessons || []).filter(lesson => lesson.published);
  if (!course || !lessons.length) return interaction.update({ content: "Khóa học chưa có bài phát hành.", components: [] });
  return interaction.update({
    content: `**${course.title}** — chọn bài học:`,
    components: [row(`learn_lesson:${course.id}`, "Chọn bài học", lessons.map(lesson => option(lesson.title, lesson.id))) ]
  });
}

async function chooseLesson(interaction) {
  const courseId = interaction.customId.slice("learn_lesson:".length);
  const course = findCourse(courseId);
  const lesson = findLesson(course, interaction.values[0]);
  if (!course || !lesson) return interaction.update({ content: "Không tìm thấy bài học.", components: [] });
  await interaction.deferUpdate();
  if (!await hasCourseAccess(interaction.user.id, course)) {
    return interaction.editReply({ content: "Bạn chưa có quyền xem khóa này hoặc gói tháng đã hết hạn. Dùng lệnh `/mua` để thanh toán.", components: [] });
  }
  return interaction.editReply({
    content: `**${course.title} · ${lesson.title}**\n[Nhấn để học trực tiếp trên web](${appUrl(course.id, lesson.id)})`,
    components: []
  });
}

async function buyProduct(interaction) {
  const [kind, id] = String(interaction.values[0] || "").split(":");
  const scope = kind === "plan" ? id : "course";
  await interaction.deferUpdate();
  const order = await createPurchase({
    discordId: interaction.user.id,
    displayName: interaction.user.globalName || interaction.user.username,
    scope,
    value: id
  });
  const bankReady = order.bank.bin && order.bank.account;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(order.reused ? "Đơn thanh toán đang chờ" : "Đã tạo đơn thanh toán")
    .setDescription(`**${order.product}**`)
    .addFields(
      { name: "Số tiền", value: `${Number(order.amount).toLocaleString("vi-VN")}đ`, inline: true },
      { name: "Nội dung chuyển khoản", value: `\`${order.purchaseCode}\``, inline: true },
      { name: "Tài khoản", value: bankReady ? `${order.bank.account} · ${order.bank.accountName || order.bank.bin}` : "Admin chưa cấu hình tài khoản ngân hàng" }
    )
    .setFooter({ text: "Chuyển đúng số tiền và nội dung. Bot sẽ mở quyền khi SePay xác nhận." });
  if (order.qrUrl) embed.setImage(order.qrUrl);
  return interaction.editReply({ content: "", embeds: [embed], components: [] });
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "hoc") return showCourses(interaction);
      if (interaction.commandName === "mua") return showProducts(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "learn_course") return chooseCourse(interaction);
      if (interaction.customId.startsWith("learn_lesson:")) return chooseLesson(interaction);
      if (interaction.customId === "buy_product") return buyProduct(interaction);
    }
  } catch (error) {
    console.error("Discord interaction error", error);
    const message = { content: "Không xử lý được yêu cầu lúc này. Vui lòng thử lại.", components: [] };
    if (interaction.deferred || interaction.replied) return interaction.editReply(message).catch(() => {});
    return interaction.reply({ ...message, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

async function startDiscordBot() {
  if (client) return client;
  if (!process.env.DISCORD_BOT_TOKEN) return null;
  publicBaseUrl();
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on("interactionCreate", handleInteraction);
  client.once(Events.ClientReady, readyClient => {
    registerCommands(readyClient.user.id)
      .then(() => console.log(`Discord bot ready as ${readyClient.user.tag}`))
      .catch(error => console.error("Could not register Discord commands", error));
  });
  await client.login(process.env.DISCORD_BOT_TOKEN);
  return client;
}

module.exports = { startDiscordBot };
