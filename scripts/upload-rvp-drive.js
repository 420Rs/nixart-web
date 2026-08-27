const fs = require("node:fs");
const path = require("node:path");
const { google } = require("googleapis");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const [filePath, folderId] = process.argv.slice(2);
  if (!filePath || !fs.statSync(filePath).isFile()) fail("Không tìm thấy file RVP để upload.");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(folderId || "")) fail("Google Drive folder ID không hợp lệ.");
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ""); }
  catch { fail("GOOGLE_SERVICE_ACCOUNT_JSON không phải JSON hợp lệ."); }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive"] });
  const drive = google.drive({ version: "v3", auth });
  const created = await drive.files.create({
    requestBody: { name: path.basename(filePath), parents: [folderId] },
    media: { mimeType: "application/octet-stream", body: fs.createReadStream(filePath) },
    fields: "id"
  });
  const id = created.data.id;
  if (!id) fail("Google Drive không trả về file ID.");
  await drive.permissions.create({ fileId: id, requestBody: { type: "anyone", role: "reader" } });
  process.stdout.write(`https://drive.google.com/file/d/${id}/view?usp=sharing`);
}

main().catch(error => fail(error?.message || String(error)));
