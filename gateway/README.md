# NIXART API gateway

The NIXART credit page is served at `/key` directly by the Worker. Customers enter their individual key; the page calls same-origin `POST /api/key/usage`, which reads the supplier's fixed `GET /api/usage/token/` endpoint with that customer's bearer token. Only remaining/used/granted credits, unlimited status and expiry are returned. Conversion matches the supplier page: 100,000 quota units per credit. Expiry 0 means no expiration. The remaining-credit bar shows the percentage of the granted quota, clamped to 0–100%; unlimited or zero-quota keys use a text label. The visible Remember key checkbox is enabled by default. Submitting a lookup stores the key only in this browser localStorage when enabled; reload restores it and performs a fresh lookup. Opting out or Clear key removes the stored credential; the preference survives reload. Browser storage failures still permit lookup in the current tab. Keys never enter the URL or cookies. Responses disable caching and provider errors are sanitized. Visible tabs refresh every 30 seconds; failures hide stale balances. The link is distributed in the private paid-order DM guide, not in public product copy.

Credit verification: fixture tests cover conversion, unlimited keys, expiry, malformed data, authentication, cross-origin rejection and sanitized upstream errors. Live `/key` and its assets return 200; a deliberately invalid key returns a sanitized 401. A real valid-key balance has not yet been checked. Lookup does not invoke a model.

Status: deployed on Cloudflare Workers on 2026-10-12 at https://nixart-api.nik-graphics99.workers.dev. Health returns 200; unauthenticated requests return 401; a deliberately invalid key is forwarded and rejected by the supplier with 401. Streaming has passed an offline check. Real model inference, tool use and credit deduction have not been tested. No real provider key is stored here or used in tests.

DNS checked on 2026-10-12: nixart.io.vn uses graham.ns.cloudflare.com and katelyn.ns.cloudflare.com. The signed-in R2/Workers account has no domain zones. The existing NIXART tunnel's saved account ID differs from the signed-in account; this does not establish that the user has a second account. The current gateway uses workers.dev, which requires no access to the domain's DNS. Attaching api.nixart.io.vn later requires access to the domain zone. Render hosts the separate shop.

Claude Code calls `https://nixart-api.nik-graphics99.workers.dev/v1/messages`; the Worker relays to `https://api.bddevlab.online/v1/messages`. Customers use their own individual provider-issued key. The provider validates that key, deducts its credit and enforces its quota. This version changes the public base URL; it does not issue NIXART keys or hide the provider-issued key from its owner. An owner could use that key directly at the provider if they know the provider URL.

The Worker passes through messages, tools, thinking, model aliases, usage, error responses and SSE without buffering. It forwards `anthropic-*` headers, supports token counting and model listing, requires credentials, uses one fixed upstream, refuses upstream redirects and disables caching. It does not log keys or request bodies in application code. Cloudflare still processes network traffic; this is not a zero retention guarantee. Provider errors may mention the supplier.

Run the offline check:

```powershell
node --test gateway/worker.test.mjs
```

The Worker was deployed through the Cloudflare dashboard in the user's existing R2 account, named `nixart-api`, with compatibility date 2026-10-12 and Workers Logs/Traces disabled. For later updates, sign in to that same Workers account and deploy `gateway/wrangler.jsonc` using Wrangler. Example from the repository root: `npx wrangler deploy --config gateway/wrangler.jsonc`. Workers deployment does not depend on the Render shop.

After deployment, GET `/health` checks the gateway without contacting the supplier. Verify streaming/tool use and credit deduction with a new disposable key with an agreed test budget before selling. Model IDs in the example are supplied aliases and have not been validated against this supplier. Client output/context limits do not enforce spending limits; those are managed on the supplier's per-key account.

Distribute claude-settings.example.json with the customer's own key substituted privately. Do not put real keys in Git or send them in public messages. Revoke the key previously pasted in chat before using it for customers.

References: [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [Claude Code connection settings](https://code.claude.com/docs/en/llm-gateway-connect), [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
