const test = require("node:test");
const assert = require("node:assert/strict");

const { groupBuyMessage } = require("../discord-bot");
const { createGroupBuyCampaign, safeHttpsUrl } = require("../groupbuy");

test("GroupBuy post shows 0/10 and both payment choices", () => {
  const message = groupBuyMessage({
    id: "blender-lighting-ab12",
    title: "Blender Lighting",
    description: "Khóa học ánh sáng",
    imageUrl: "https://cdn.example.test/course.jpg",
    previewUrl: "https://example.test/preview",
    totalPrice: 400000,
    targetSlots: 10,
    sharePrice: 40000,
    paidSlots: 0,
    reservedSlots: 0,
    exclusivePaid: false,
    exclusiveReserved: false,
    status: "open"
  });
  const json = { embeds: message.embeds.map(embed => embed.toJSON()), components: message.components.map(row => row.toJSON()) };
  assert.equal(json.embeds[0].fields.find(field => field.name === "Tiến độ").value.includes("0/10"), true);
  assert.equal(json.components[0].components[0].custom_id, "groupbuy_share:blender-lighting-ab12");
  assert.equal(json.components[0].components[0].label, "Góp 40.000đ");
  assert.equal(json.components[0].components[1].custom_id, "groupbuy_exclusive:blender-lighting-ab12");
  assert.equal(json.components[0].components[1].label, "Mua độc quyền 400.000đ");
  assert.equal(json.components[0].components[2].style, 5);
});

test("a pending contribution disables exclusive purchase", () => {
  const json = groupBuyMessage({
    id: "course-ab12", title: "Course", description: "", imageUrl: "", previewUrl: "",
    totalPrice: 400000, targetSlots: 10, sharePrice: 40000, paidSlots: 0, reservedSlots: 1,
    exclusivePaid: false, exclusiveReserved: false, status: "open"
  }).components[0].toJSON();
  assert.equal(json.components[0].disabled, false);
  assert.equal(json.components[1].disabled, true);
});

test("GroupBuy campaign defaults to 400k split across 10 people", async () => {
  const sql = async (strings, ...values) => [{
    id: "blender-course-ab12",
    title: values[1],
    description: values[2],
    image_url: values[3],
    preview_url: values[4],
    total_price: values[5],
    target_slots: values[6],
    reserved_slots: 0,
    exclusive_reserved: false,
    status: "open",
    channel_id: values[7],
    message_id: null
  }];
  const campaign = await createGroupBuyCampaign({
    title: "Blender Course",
    channelId: "1534754527671091270",
    createdBy: "820650129529765938"
  }, sql);
  assert.equal(campaign.totalPrice, 400000);
  assert.equal(campaign.targetSlots, 10);
  assert.equal(campaign.sharePrice, 40000);
  assert.equal(safeHttpsUrl("javascript:alert(1)"), "");
});
