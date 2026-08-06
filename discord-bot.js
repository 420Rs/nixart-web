const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const {
  effectiveDeliveryMode,
  escapeDiscordMarkdown,
  createPurchase,
  findCourse,
  findLesson,
  findSaleCourse,
  getCatalog,
  getPendingDiscordPaymentNotifications,
  googleEmail,
  hasCourseAccess,
  isCourseContentReady,
  isCourseSaleReady,
  isForumCourseSaleReady,
  markDiscordPaymentNotified
} = require("./learning");
const {
  DEFAULT_GROUPBUY_CHANNEL_ID,
  attachGroupBuyMessage,
  createGroupBuyCampaign,
  createGroupBuyPurchase,
  getGroupBuyCampaign,
  getPendingGroupBuyNotifications,
  markGroupBuyNotified
} = require("./groupbuy");

let client;

function isDiscordBotReady() {
  return client?.isReady() === true;
}

function publishedCourses() {
  return (getCatalog().courses || []).filter(isCourseContentReady);
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

function paymentApprovedMessage(order, catalog = getCatalog()) {
  const courses = (catalog.courses || []).filter(isCourseContentReady);
  if (order.access_scope === "course") {
    const course = courses.find(item => item.id === order.course_id);
    const lessons = (course?.lessons || []).filter(lesson => lesson.published);
    if (!course || !lessons.length) return null;
    const components = lessons.length <= 25
      ? [row(`learn_lesson:${course.id}`, "Chọn bài học", lessons.map(lesson => option(lesson.title, lesson.id)))]
      : [new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setLabel("Mở khóa học và chọn bài")
        .setStyle(ButtonStyle.Link)
        .setURL(appUrl(course.id, lessons[0].id)))];
    return {
      content: `✅ **Thanh toán thành công**\nBạn đã được mở khóa **${escapeDiscordMarkdown(course.title)}**. Chọn bài học để bắt đầu:`,
      components
    };
  }
  const available = courses.filter(course => order.access_scope === "full" || course.planTier === "basic");
  return {
    content: `✅ **Thanh toán thành công**\nGói **${escapeDiscordMarkdown(order.course_title)}** đã được kích hoạt. Chọn khóa học:`,
    components: available.length
      ? [row("learn_course", "Chọn khóa học", available.map(course => option(course.title, course.id, course.description)))]
      : []
  };
}

function groupBuyMessage(campaign) {
  const paid = Math.min(campaign.targetSlots, campaign.paidSlots);
  const pending = Math.max(0, campaign.reservedSlots - paid);
  const closed = campaign.status !== "open";
  const exclusiveLocked = campaign.exclusiveReserved || campaign.exclusivePaid || campaign.reservedSlots > 0;
  const status = campaign.status === "exclusive" ? "Đã có người mua độc quyền"
    : campaign.status === "funded" ? "Đã đủ người góp"
      : campaign.exclusiveReserved ? "Đang chờ thanh toán độc quyền"
        : "Đang mở GroupBuy";
  const progress = `${"🟩".repeat(Math.min(paid, 10))}${"⬜".repeat(Math.max(0, Math.min(campaign.targetSlots, 10) - paid))}`;
  const embed = new EmbedBuilder()
    .setColor(closed ? 0x4ddb8e : 0x5865f2)
    .setTitle(campaign.title)
    .setDescription(campaign.description || "Cùng góp để sở hữu khóa học với chi phí thấp hơn.")
    .addFields(
      { name: "Trạng thái", value: status, inline: true },
      { name: "Giá đầy đủ", value: `${campaign.totalPrice.toLocaleString("vi-VN")}đ`, inline: true },
      { name: "Mỗi suất góp", value: `${campaign.sharePrice.toLocaleString("vi-VN")}đ`, inline: true },
      { name: "Tiến độ", value: `**${paid}/${campaign.targetSlots}**${pending ? ` · ${pending} đang chờ thanh toán` : ""}\n${progress}`, inline: false }
    )
    .setFooter({ text: `Mã GroupBuy: ${campaign.id} · Có thể góp nhiều suất · Không giới hạn thời gian` });
  if (campaign.imageUrl) embed.setImage(campaign.imageUrl);
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`groupbuy_share:${campaign.id}`)
      .setLabel(`Góp ${campaign.sharePrice.toLocaleString("vi-VN")}đ`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(closed || campaign.exclusiveReserved || campaign.reservedSlots >= campaign.targetSlots),
    new ButtonBuilder()
      .setCustomId(`groupbuy_exclusive:${campaign.id}`)
      .setLabel(`Mua độc quyền ${campaign.totalPrice.toLocaleString("vi-VN")}đ`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(closed || exclusiveLocked)
  ];
  if (campaign.courseUrl) buttons.push(new ButtonBuilder().setLabel("Link khóa học").setStyle(ButtonStyle.Link).setURL(campaign.courseUrl));
  if (campaign.previewUrl) buttons.push(new ButtonBuilder().setLabel("Xem trước").setStyle(ButtonStyle.Link).setURL(campaign.previewUrl));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons)] };
}

async function refreshGroupBuyMessage(campaignId) {
  if (!client?.isReady()) throw new Error("Discord bot is not ready");
  const campaign = await getGroupBuyCampaign(campaignId);
  if (!campaign?.messageId) return campaign;
  const channel = await client.channels.fetch(campaign.channelId);
  const message = await channel.messages.fetch(campaign.messageId);
  await message.edit(groupBuyMessage(campaign));
  return campaign;
}

async function notifyGroupBuyApproved(order) {
  if (!client?.isReady()) throw new Error("Discord bot is not ready");
  const campaign = await refreshGroupBuyMessage(order.course_id);
  if (!campaign) throw new Error(`GroupBuy không tồn tại: ${order.course_id}`);
  const exclusive = order.access_scope === "groupbuy_exclusive";
  const user = await client.users.fetch(String(order.discord_id));
  await user.send({
    content: exclusive
      ? `✅ **Thanh toán độc quyền thành công**\nBạn đã mua toàn bộ **${escapeDiscordMarkdown(campaign.title)}**. Admin sẽ liên hệ để bàn giao.`
      : `✅ **Góp GroupBuy thành công**\nBạn đã được ghi nhận 1 suất trong **${escapeDiscordMarkdown(campaign.title)}** (${campaign.paidSlots}/${campaign.targetSlots}). Bot sẽ thông báo khi đủ người và khóa học sẵn sàng.`
  });
}

async function notifyPaymentApproved(order) {
  if (!client?.isReady()) throw new Error("Discord bot is not ready");
  const message = paymentApprovedMessage(order);
  if (!message) throw new Error(`Course is unavailable after payment: ${order.course_id}`);
  const user = await client.users.fetch(String(order.discord_id));
  await user.send(message);
}

async function notifyPendingPayments() {
  for (const order of await getPendingDiscordPaymentNotifications()) {
    try {
      await notifyPaymentApproved(order);
      await markDiscordPaymentNotified(order.id);
    } catch (error) {
      console.error(`Could not notify paid Discord order ${order.id}`, error);
    }
  }
}

async function notifyPendingGroupBuyPayments() {
  for (const order of await getPendingGroupBuyNotifications()) {
    try {
      await notifyGroupBuyApproved(order);
      await markGroupBuyNotified(order.id);
    } catch (error) {
      console.error(`Could not notify paid GroupBuy order ${order.id}`, error);
    }
  }
}

async function registerCommands(applicationId) {
  const commands = [
    new SlashCommandBuilder().setName("hoc").setDescription("Chọn khóa học và bài học để xem trên web"),
    new SlashCommandBuilder().setName("mua").setDescription("Mua lẻ khóa học hoặc đăng ký gói tháng"),
    new SlashCommandBuilder()
      .setName("groupbuy-tao")
      .setDescription("Tạo một khóa GroupBuy mới")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption(option => option.setName("tieu-de").setDescription("Tên khóa học").setRequired(true).setMaxLength(100))
      .addStringOption(option => option.setName("mo-ta").setDescription("Mô tả ngắn").setMaxLength(1000))
      .addStringOption(option => option.setName("link-khoa").setDescription("Link khóa học HTTPS").setMaxLength(2000))
      .addIntegerOption(option => option.setName("gia").setDescription("Giá đầy đủ, mặc định 400000").setMinValue(10000).setMaxValue(2000000000))
      .addIntegerOption(option => option.setName("so-nguoi").setDescription("Số người góp, mặc định 10").setMinValue(2).setMaxValue(100))
      .addStringOption(option => option.setName("anh").setDescription("Link ảnh HTTPS").setMaxLength(2000))
      .addStringOption(option => option.setName("xem-truoc").setDescription("Link preview HTTPS").setMaxLength(2000))
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
    .map(plan => option(
      `${plan.title} — ${Number(plan.price).toLocaleString("vi-VN")}đ`,
      `plan:${plan.id}`,
      `${plan.durationDays || 30} ngày · chỉ thư viện STREAM`
    ));
  const courses = (catalog.courses || []).filter(isCourseSaleReady)
    .map(course => option(
      `${course.title} — ${Number(course.price).toLocaleString("vi-VN")}đ`,
      `course:${course.id}`,
      effectiveDeliveryMode(course) === "DRIVE" ? "Nhận qua Google Drive" : "Học trực tiếp trên web"
    ));
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

async function freeCourseButton(interaction) {
  const id = interaction.customId.slice("free_course:".length);
  const course = findCourse(id);
  const lessons = (course?.lessons || []).filter(lesson => lesson.published);
  if (!course || course.freeAccess !== true || !lessons.length) {
    return interaction.reply({ content: "Khóa học này hiện không còn chia sẻ miễn phí.", flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({
    content: `**${course.title}** — chọn bài học:`,
    components: [row(`learn_lesson:${course.id}`, "Chọn bài học", lessons.map(lesson => option(lesson.title, lesson.id)))],
    flags: MessageFlags.Ephemeral
  });
}

function driveEmailModal(course) {
  return new ModalBuilder()
    .setCustomId(`drive_email:${course.id}`)
    .setTitle("Email nhận khóa học Google Drive")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("google_email")
        .setLabel("Email đăng nhập Google Drive")
        .setPlaceholder("ban@example.com")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(254)
    ));
}

async function createPaymentReply(interaction, scope, id, update, email = "") {
  if (update) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const order = await createPurchase({
    discordId: interaction.user.id,
    displayName: interaction.user.globalName || interaction.user.username,
    scope,
    value: id,
    email
  });
  return renderPaymentReply(interaction, order);
}

async function renderPaymentReply(interaction, order) {
  const bankReady = order.bank.bin && order.bank.account;
  const fields = [
    { name: "Số tiền", value: `${Number(order.amount).toLocaleString("vi-VN")}đ`, inline: true },
    { name: "Nội dung chuyển khoản", value: `\`${order.purchaseCode}\``, inline: true },
    { name: "Tài khoản", value: bankReady ? `${order.bank.account} · ${order.bank.accountName || order.bank.bin}` : "Admin chưa cấu hình tài khoản ngân hàng" }
  ];
  if (order.deliveryType === "drive") fields.push({ name: "Email Google", value: escapeDiscordMarkdown(order.email) });
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(order.reused ? "Đơn thanh toán đang chờ" : "Đã tạo đơn thanh toán")
    .setDescription(`**${escapeDiscordMarkdown(order.product)}**`)
    .addFields(...fields)
    .setFooter({
      text: order.deliveryType === "drive"
        ? "Chuyển đúng nội dung. SePay xác nhận xong, email trên sẽ được thêm vào thư mục Drive."
        : order.deliveryType === "groupbuy"
          ? "Đơn GroupBuy không hết hạn. Mỗi lần góp tạo một mã riêng; SePay xác nhận xong bot sẽ cộng một suất."
        : order.scope !== "course"
          ? "Gói tháng áp dụng cho STREAM; khóa DRIVE bán lẻ. Bot mở quyền khi SePay xác nhận."
          : "Chuyển đúng số tiền và nội dung. Bot sẽ mở quyền khi SePay xác nhận."
    });
  if (order.qrUrl) embed.setImage(order.qrUrl);
  return interaction.editReply({ content: "", embeds: [embed], components: [] });
}

async function createGroupBuyCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: "Bạn không có quyền tạo GroupBuy.", flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channelId = String(process.env.DISCORD_GROUPBUY_CHANNEL_ID || DEFAULT_GROUPBUY_CHANNEL_ID);
  const campaign = await createGroupBuyCampaign({
    title: interaction.options.getString("tieu-de", true),
    description: interaction.options.getString("mo-ta") || "",
    courseUrl: interaction.options.getString("link-khoa") || "",
    totalPrice: interaction.options.getInteger("gia") || 400000,
    targetSlots: interaction.options.getInteger("so-nguoi") || 10,
    imageUrl: interaction.options.getString("anh") || "",
    previewUrl: interaction.options.getString("xem-truoc") || "",
    channelId,
    createdBy: interaction.user.id
  });
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("Kênh GroupBuy không phải kênh text");
  const message = await channel.send(groupBuyMessage(campaign));
  await attachGroupBuyMessage(campaign.id, message.id);
  return interaction.editReply({ content: `Đã đăng **${escapeDiscordMarkdown(campaign.title)}**: https://discord.com/channels/${interaction.guildId}/${channelId}/${message.id}` });
}

async function groupBuyButton(interaction) {
  const [prefix, id] = interaction.customId.split(":", 2);
  const kind = prefix === "groupbuy_exclusive" ? "exclusive" : "share";
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const order = await createGroupBuyPurchase({
    campaignId: id,
    kind,
    discordId: interaction.user.id,
    displayName: interaction.user.globalName || interaction.user.username
  });
  await refreshGroupBuyMessage(id);
  return renderPaymentReply(interaction, order);
}

async function buyProduct(interaction) {
  const [kind, id] = String(interaction.values[0] || "").split(":");
  if (kind === "plan") return createPaymentReply(interaction, id, id, true);
  const course = findSaleCourse(id);
  if (!course) return interaction.update({ content: "Khóa học này chưa mở thanh toán.", components: [] });
  if (effectiveDeliveryMode(course) === "DRIVE") return interaction.showModal(driveEmailModal(course));
  return createPaymentReply(interaction, "course", id, true);
}

async function buyCourseButton(interaction) {
  const id = interaction.customId.slice("buy_course:".length);
  const course = findSaleCourse(id);
  if (!isForumCourseSaleReady(course)) {
    return interaction.reply({ content: "Khóa học này chưa mở thanh toán.", flags: MessageFlags.Ephemeral });
  }
  if (effectiveDeliveryMode(course) === "DRIVE") return interaction.showModal(driveEmailModal(course));
  return createPaymentReply(interaction, "course", id, false);
}

async function driveEmailSubmit(interaction) {
  const id = interaction.customId.slice("drive_email:".length);
  const course = findSaleCourse(id);
  const email = googleEmail(interaction.fields.getTextInputValue("google_email"));
  if (!course || effectiveDeliveryMode(course) !== "DRIVE" || !email) {
    return interaction.reply({ content: "Khóa học hoặc email Google không hợp lệ.", flags: MessageFlags.Ephemeral });
  }
  return createPaymentReply(interaction, "course", id, false, email);
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "hoc") return showCourses(interaction);
      if (interaction.commandName === "mua") return showProducts(interaction);
      if (interaction.commandName === "groupbuy-tao") return createGroupBuyCommand(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "learn_course") return chooseCourse(interaction);
      if (interaction.customId.startsWith("learn_lesson:")) return chooseLesson(interaction);
      if (interaction.customId === "buy_product") return buyProduct(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith("drive_email:")) return driveEmailSubmit(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("free_course:")) return freeCourseButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("buy_course:")) return buyCourseButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("groupbuy_share:")) return groupBuyButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith("groupbuy_exclusive:")) return groupBuyButton(interaction);
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
  client.on(Events.Error, error => console.error("Discord client error", error));
  client.on(Events.ShardError, error => console.error("Discord shard error", error));
  client.on("interactionCreate", handleInteraction);
  client.once(Events.ClientReady, readyClient => {
    registerCommands(readyClient.user.id)
      .then(() => console.log(`Discord bot ready as ${readyClient.user.tag}`))
      .catch(error => console.error("Could not register Discord commands", error));
    notifyPendingPayments().catch(error => console.error("Could not recover Discord payment notifications", error));
    notifyPendingGroupBuyPayments().catch(error => console.error("Could not recover GroupBuy notifications", error));
  });
  await client.login(process.env.DISCORD_BOT_TOKEN);
  return client;
}

module.exports = {
  driveEmailModal,
  groupBuyMessage,
  isDiscordBotReady,
  notifyGroupBuyApproved,
  notifyPaymentApproved,
  paymentApprovedMessage,
  refreshGroupBuyMessage,
  startDiscordBot
};
