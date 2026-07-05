const http = require("http");
const fs = require("fs");
const path = require("path");

const handlers = {
  "/api/state": "./netlify/functions/state",
  "/api/auth": "./netlify/functions/auth",
  "/api/admin-orders": "./netlify/functions/admin-orders",
  "/api/order-lookup": "./netlify/functions/order-lookup",
  "/api/traffic": "./netlify/functions/traffic",
  "/api/orders": "./netlify/functions/orders",
  "/api/sepay": "./netlify/functions/sepay",
  "/review": "./netlify/functions/review"
};

function send(res, result) {
  res.writeHead(result.statusCode || 200, result.headers || {});
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") return send(res, { statusCode: 200, body: "ok" });

    const handlerPath = handlers[url.pathname];
    if (handlerPath) {
      return send(res, await require(handlerPath).handler({
        httpMethod: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? "" : await readBody(req),
        rawQuery: url.search.slice(1),
        queryStringParameters: Object.fromEntries(url.searchParams)
      }));
    }

    const files = { "/": "index.html", "/index.html": "index.html", "/favicon.svg": "favicon.svg" };
    const file = files[url.pathname];
    if (!file) return send(res, { statusCode: 404, body: "Not found" });
    res.writeHead(200, {
      "Content-Type": file.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8",
      "Cache-Control": file === "index.html" ? "no-cache" : "public, max-age=86400"
    });
    fs.createReadStream(path.join(__dirname, file)).pipe(res);
  } catch (error) {
    console.error("server error", error);
    if (!res.headersSent) send(res, { statusCode: 500, body: "Server error" });
    else res.end();
  }
});

server.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => {
  console.log(`Nixart listening on ${process.env.PORT || 3000}`);
});
