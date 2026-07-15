const { listEmailAccess, revokeEmailAccess } = require("../learning");

function argumentsFrom(values) {
  if (values.length === 1 && values[0] === "--list") return { action: "list" };
  if (values.length === 2 && values[0] === "--revoke" && values[1]) {
    return { action: "revoke", id: values[1] };
  }
  throw new Error("Dùng --list hoặc --revoke <mã-quyền>");
}

async function main(values = process.argv.slice(2)) {
  const args = argumentsFrom(values);
  if (args.action === "list") {
    console.log(JSON.stringify(await listEmailAccess()));
    return;
  }
  const revoked = await revokeEmailAccess(args.id);
  console.log(`Đã thu hồi: ${revoked.email} · ${revoked.courseTitle}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { argumentsFrom, main };
