const test = require("node:test");
const assert = require("node:assert/strict");

const { groupBuyMessage } = require("../discord-bot");
const { attachGroupBuyPost, createGroupBuyCampaign, createGroupBuyPurchase, safeHttpsUrl } = require("../groupbuy");

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
  assert.equal(json.components[0].components[2].url, "https://example.test/course");
  assert.equal(json.components[0].components[3].style, 5);
  assert.equal(json.components[0].components.some(component => component.custom_id?.startsWith("groupbuy_test:")), false);
  assert.match(json.embeds[0].footer.text, /góp nhiều suất/);
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

test("one Discord ID can create multiple contribution orders", async () => {
  const queries = [];
  let inserts = 0;
  const campaignRow = reserved => ({
    id: "course-ab12", title: "Course", description: "", course_url: "https://example.test/course",
    image_url: "", preview_url: "", total_price: 400000, target_slots: 10,
    reserved_slots: reserved, paid_slots: 0, exclusive_paid: false, exclusive_reserved: false,
    status: "open", channel_id: "1534754527671091270", message_id: "1534758082024968243"
  });
  const sql = async (strings) => {
    const source = strings.join(" ? ");
    queries.push(source);
    if (source.includes("UPDATE groupbuy_campaigns SET reserved_slots")) return [campaignRow(inserts + 1)];
    if (source.includes("INSERT INTO purchase_orders")) {
      inserts += 1;
      return [{ purchase_code: `NIXORDER${inserts}`, course_title: "Course", amount: 40000, access_scope: "groupbuy_share", status: "pending" }];
    }
    if (source.includes("FROM groupbuy_campaigns campaign")) return [campaignRow(inserts)];
    throw new Error(`Unexpected SQL: ${source}`);
  };
  const input = { campaignId: "course-ab12", kind: "share", discordId: "820650129529765938", displayName: "Buyer" };
  const first = await createGroupBuyPurchase(input, sql);
  const second = await createGroupBuyPurchase(input, sql);
  assert.equal(first.amount, 40000);
  assert.equal(second.amount, 40000);
  assert.notEqual(first.purchaseCode, second.purchaseCode);
  assert.equal(inserts, 2);
  assert.equal(queries.filter(query => query.includes("UPDATE groupbuy_campaigns SET reserved_slots")).length, 2);
});

test("forum post stores its thread as the campaign channel", async () => {
  let values;
  const sql = async (_strings, ...params) => { values = params; return []; };
  await attachGroupBuyPost("course-ab12", "1535000000000000001", "1535000000000000001", sql);
  assert.deepEqual(values, ["1535000000000000001", "1535000000000000001", "course-ab12"]);
});
