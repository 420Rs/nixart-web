const { REST, Routes } = require("discord.js");
const { groupBuyMessage } = require("../discord-bot");
const {
  DEFAULT_GROUPBUY_CHANNEL_ID,
  attachGroupBuyMessage,
  createGroupBuyCampaign,
  listGroupBuyCampaigns
} = require("../groupbuy");

function inputFromBase64(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("Dữ liệu GroupBuy từ app không hợp lệ");
  }
}

async function createAndPublish(input) {
  if (!process.env.DISCORD_BOT_TOKEN) throw new Error("Thiếu DISCORD_BOT_TOKEN");
  const channelId = String(process.env.DISCORD_GROUPBUY_CHANNEL_ID || DEFAULT_GROUPBUY_CHANNEL_ID);
  const campaign = await createGroupBuyCampaign({
    ...input,
    channelId,
    createdBy: String(process.env.DISCORD_OWNER_ID || "820650129529765938")
  });
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
  const channel = await rest.get(Routes.channel(channelId));
  if (channel.type !== 0) throw new Error("Kênh GroupBuy phải là text channel");
  const built = groupBuyMessage(campaign);
  const message = await rest.post(Routes.channelMessages(channelId), {
    body: {
      embeds: built.embeds.map(embed => embed.toJSON()),
      components: built.components.map(row => row.toJSON()),
      allowed_mentions: { parse: [] }
    }
  });
  await attachGroupBuyMessage(campaign.id, message.id);
  return { ...campaign, messageId: message.id, discordUrl: `https://discord.com/channels/${channel.guild_id}/${channelId}/${message.id}` };
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--list") {
    process.stdout.write(JSON.stringify(await listGroupBuyCampaigns()));
    return;
  }
  if (args.length === 2 && args[0] === "--create-base64") {
    process.stdout.write(JSON.stringify(await createAndPublish(inputFromBase64(args[1]))));
    return;
  }
  throw new Error("Dùng --list hoặc --create-base64 <base64>");
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { createAndPublish, inputFromBase64, main };
