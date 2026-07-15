const http = require("http");
const fs = require("fs");
const path = require("path");
const { ensureAuthTables, parseCookies } = require("./netlify/functions/lib/auth");
const { COOKIE_NAME, verifyMediaToken } = require("./netlify/functions/lib/media-token");
const { ensureLearningTables } = require("./learning");
const { isDiscordBotReady, startDiscordBot } = require("./discord-bot");

const handlers = {
  "/api/state": "./netlify/functions/state",
  "/api/auth": "./netlify/functions/auth",
  "/api/discord-auth": "./netlify/functions/discord-auth",
  "/api/google-auth": "./netlify/functions/google-auth",
  "/api/catalog": "./netlify/functions/catalog",
  "/api/learning-access": "./netlify/functions/learning-access",
  "/api/admin-orders": "./netlify/functions/admin-orders",
  "/api/order-lookup": "./netlify/functions/order-lookup",
  "/api/traffic": "./netlify/functions/traffic",
  "/api/orders": "./netlify/functions/orders",
  "/api/sepay": "./netlify/functions/sepay",
  "/review": "./netlify/functions/review"
};

const staticFiles = {
  "/": "index.html",
  "/index.html": "index.html",
  "/learn": "learn.html",
  "/learn/": "learn.html",
  "/learn.html": "learn.html",
  "/favicon.svg": "favicon.svg"
};

const mediaTypes = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".key": "application/octet-stream"
};

function send(res, result) {
  const headers = { ...(result.headers || {}) };
  for (const [name, values] of Object.entries(result.multiValueHeaders || {})) headers[name] = values;
  res.writeHead(result.statusCode || 200, headers);
  res.end(result.body || "");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.on("data", chunk => {
      value += chunk;
      if (value.length > 1_000_000) reject(new Error("Request too large"));
    });
    req.on("end", () => resolve(value));
    req.on("error", reject);
  });
}

function serveStatic(res, file, method) {
  const contentType = file.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
  if (method === "HEAD") return res.end();
  fs.createReadStream(path.join(__dirname, file)).pipe(res);
}

function serveMedia(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) return send(res, { statusCode: 405, headers: { Allow: "GET, HEAD" }, body: "Method not allowed" });
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "media") return send(res, { statusCode: 404, body: "Not found" });
  const [, courseId, lessonId, filename] = parts;
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(courseId) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(lessonId)
      || !/^[a-zA-Z0-9_.-]{1,120}\.(m3u8|ts|m4s|mp4|key)$/.test(filename)) {
    return send(res, { statusCode: 404, body: "Not found" });
  }

  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!verifyMediaToken(token, courseId, lessonId)) {
    return send(res, { statusCode: 403, headers: { "Cache-Control": "no-store" }, body: "Forbidden" });
  }

  const root = path.resolve(process.env.MEDIA_ROOT || path.join(__dirname, "media"));
  const target = path.resolve(root, courseId, lessonId, filename);
  if (path.relative(root, target).startsWith("..")) return send(res, { statusCode: 404, body: "Not found" });

  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) return send(res, { statusCode: 404, body: "Not found" });
    const headers = {
      "Content-Type": mediaTypes[path.extname(filename)] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": filename.endsWith(".m3u8") ? "private, no-cache" : "private, max-age=3600, immutable",
      "X-Content-Type-Options": "nosniff"
    };
    const match = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      let start;
      let end;
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        start = Math.max(0, stat.size - suffixLength);
        end = stat.size - 1;
      } else {
        start = match[1] ? Number(match[1]) : 0;
        end = match[2] ? Number(match[2]) : stat.size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= stat.size) {
        return send(res, { statusCode: 416, headers: { "Content-Range": `bytes */${stat.size}` }, body: "" });
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(target, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      return send(res, { statusCode: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "ok" });
    }
    if (url.pathname === "/health/discord") {
      const ready = isDiscordBotReady();
      return send(res, {
        statusCode: ready ? 200 : 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        body: ready ? "ready" : "offline"
      });
    }
    if (url.pathname.startsWith("/media/")) return serveMedia(req, res, url.pathname);

    const handlerPath = handlers[url.pathname];
    if (handlerPath) {
      const event = {
        httpMethod: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? "" : await readBody(req),
        rawQuery: url.search.slice(1),
        queryStringParameters: Object.fromEntries(url.searchParams)
      };
      return send(res, await require(handlerPath).handler(event));
    }

    const file = staticFiles[url.pathname];
    if (file && ["GET", "HEAD"].includes(req.method)) return serveStatic(res, file, req.method);
    return send(res, { statusCode: 404, body: "Not found" });
  } catch (error) {
    console.error("server error", error);
    if (!res.headersSent) send(res, { statusCode: 500, body: "Server error" });
    else res.end();
  }
});

if (require.main === module) {
  (async () => {
    await ensureAuthTables();
    await ensureLearningTables();
    if (process.env.DISCORD_BOT_TOKEN) await startDiscordBot();
    server.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => {
      console.log(`Nixart listening on ${process.env.PORT || 3000}`);
    });
  })().catch(error => {
    console.error("Startup failed", error);
    process.exitCode = 1;
  });
}

module.exports = { server };
