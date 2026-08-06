const test = require("node:test");
const assert = require("node:assert/strict");

const { groupBuyMessage } = require("../discord-bot");
const { createGroupBuyCampaign, createGroupBuyPurchase, safeHttpsUrl } = require("../groupbuy");

test("GroupBuy post shows 0/10 and both payment choices", () => {
  const message = groupBuyMessage({
    id: "blender-lighting-ab12",
    title: "Blender Lighting",
    description: "Khóa học ánh sáng",
    courseUrl: "https://example.test/course",
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
  assert.equal(json.components[0].components[2].custom_id, "groupbuy_test:blender-lighting-ab12");
  assert.equal(json.components[0].components[3].url, "https://example.test/course");
  assert.equal(json.components[0].components[4].style, 5);
  assert.match(json.embeds[0].footer.text, /Không giới hạn thời gian/);
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
    course_url: values[3],
    image_url: values[4],
    preview_url: values[5],
    total_price: values[6],
    target_slots: values[7],
    reserved_slots: 0,
    exclusive_reserved: false,
    status: "open",
    channel_id: values[8],
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

test("test Discord ID can create unlimited non-reserving orders", async () => {
  const queries = [];
  const sql = async (strings) => {
    const source = strings.join(" ? ");
    queries.push(source);
    if (source.includes("FROM groupbuy_campaigns campaign")) return [{
      id: "course-ab12", title: "Course", description: "", course_url: "https://example.test/course",
      image_url: "", preview_url: "", total_price: 400000, target_slots: 10,
      reserved_slots: 0, paid_slots: 0, exclusive_paid: false, exclusive_reserved: false,
      status: "open", channel_id: "1534754527671091270", message_id: "1534758082024968243"
    }];
    if (source.includes("INSERT INTO purchase_orders")) return [{
      purchase_code: "NIXTEST1234", course_title: "Course", amount: 40000,
      access_scope: "groupbuy_test", status: "pending"
    }];
    throw new Error(`Unexpected SQL: ${source}`);
  };
  const order = await createGroupBuyPurchase({
    campaignId: "course-ab12", kind: "test", discordId: "820650129529765938", displayName: "Tester"
  }, sql);
  assert.equal(order.amount, 40000);
  assert.equal(order.scope, "test");
  assert.equal(queries.some(query => query.includes("UPDATE groupbuy_campaigns")), false);
});
