const { grantEmailAccess } = require("../learning");

function argumentsFrom(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!["--email", "--course", "--plan", "--name"].includes(key) || index + 1 >= values.length) {
      throw new Error(`Tham số không hợp lệ: ${key || "(trống)"}`);
    }
    result[key.slice(2)] = values[index + 1];
    index += 1;
  }
  if (!result.email || Boolean(result.course) === Boolean(result.plan)) {
    throw new Error("Dùng --email cùng đúng một trong --course hoặc --plan");
  }
  return result;
}

async function main(values = process.argv.slice(2)) {
  const args = argumentsFrom(values);
  const access = await grantEmailAccess({
    email: args.email,
    displayName: args.name,
    scope: args.course ? "course" : args.plan,
    value: args.course || args.plan
  });
  const expiry = access.expiresAt ? new Date(access.expiresAt).toLocaleString("vi-VN") : "không hết hạn";
  console.log(`${access.reused ? "Đã có" : "Đã cấp"}: ${access.email} · ${access.product} · ${expiry}`);
  if (!access.userId) console.log("Quyền sẽ tự gắn khi Gmail/Google Workspace này đăng nhập lần đầu.");
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { argumentsFrom, main };
