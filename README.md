## srtnr-mini — a headless url shortener

a simple, lightweight, headless url shortener written in typescript that uses cloudflare kv and secrets store to manage links on the edge.

### features
- **shorten**: POST `/api/shorten` with `{ url, slug? }` → returns `shortUrl` and `slug`.
- **redirects**: GET `/{slug}` → 301 redirect to the original URL.
- **delete**: DELETE `/api/delete` with `{ slug }` → removes the mapping.
- **auth**: `Authorization: Bearer <key>` required for POST/DELETE. keys are whitelisted via secrets store or `.dev.vars`. api keys are stored in the secrets store, so you can rotate them without redeploying the worker.
- **storage**: cloudflare KV binding `URL_KV` stores `{ originalUrl, slug, created }` for each link.
- **clicks**: cloudflare KV binding `LINK_CLICKS_KV` stores click counts per slug (`key = slug`, `value = number as string`).

---

## quickstart

### prerequisites
- Cloudflare account and Wrangler CLI (`pnpm i -g wrangler`)
- pnpm

### install
```bash
pnpm i
```

### configure wrangler bindings
see `wrangler.example.jsonc` for an example.

notes:
- `binding` is the variable exposed to your worker (must be `API_KEYS` to match `env.API_KEYS`).
- `secret_name` is the secret object in your store; you can keep it `API_KEYS` or use another name.

### local development
- create `.dev.vars` (dotenv format), value is a JSON array of allowed keys:

```dotenv
API_KEYS=["your-key-1","your-key-2"]
```

- run local using remote (default) or force local env loading:
```bash
# Remote dev (uses Secrets Store)
pnpm wrangler dev

# Local dev (uses .dev.vars) -- use this only if you haven't configured the secrets store
pnpm wrangler dev --local
```

### remote/prod secrets (secrets store)
create or update a secret named `API_KEYS` in your store with a JSON array value, e.g. `["your-key-1","your-key-2"]`.

## api reference

### auth
- provide `Authorization: Bearer <key>` header for POST, DELETE, and list routes.
- keys must be present in the array configured via secrets store (remote) or `.dev.vars` (local `--local`).
- errors: `401 { "error": "Missing or invalid API key" }` when header is missing or key not whitelisted.

### GET `/`
- health check.
- response: `200 { "ok": true, "service": "srtnr-mini" }`

### POST `/api/shorten`
- auth: required.
- body (JSON):
  - `url` (string, required) — must start with `http`.
  - `slug` (string, optional) — custom slug; must be unique. If omitted, a 6-char `[a-z0-9]` slug is generated.
- success: `200 { "shortUrl": "https://<host>/<slug>", "slug": "<slug>" }`
- errors:
  - `400 { "error": "Invalid URL" }`
  - `401 { "error": "Missing or invalid API key" }`
  - `500 { "error": "Server Error" }`
- Example:
```bash
curl -X POST https://<your-worker>.workers.dev/api/shorten \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","slug":"example"}'
```

### DELETE `/api/delete`
- auth: required.
- body (JSON):
  - `slug` (string, required)
- success: `200 { "message": "Link deleted" }`
- errors:
  - `400 { "error": "Missing slug" }`
  - `401 { "error": "Missing or invalid API key" }`
  - `404 { "error": "Slug not found" }`
  - `500 { "error": "Server Error" }`
- Example:
```bash
curl -X DELETE https://<your-worker>.workers.dev/api/delete \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"slug":"example"}'
```

### GET `/{slug}`
- redirects to the original URL.
- success: `301` redirect.
- errors: `404 not found` when slug does not exist.

### GET `/api/links/:slug` (alias: `/links/:slug`)
- auth: required.
- returns metadata and click count for a specific slug.
- success: `200 { slug, destination, created, clicks }`
- errors: `404 { "error": "Slug not found" }`

### GET `/api/links` (alias: `/links`) [auth required]
- lists all links with metadata and click counts.
- success: `200 { links: [{ slug, destination, created, clicks }, ...] }`
- errors:
  - `401 { "error": "Missing or invalid API key" }`
  - `501 { "error": "KV list not supported in this environment" }` when `KV.list()` isn't available.

---

## api key management

### generate a key 
```bash
openssl rand -hex 32
```

### add to local dev
Edit `.dev.vars`:
```dotenv
API_KEYS=["api-key-1","api-key-2"]
```
Run with `pnpm wrangler dev --local` to use `.dev.vars`.

### rotate keys
- Update both `.dev.vars` and Secrets Store to include the new key.
- Deploy/test with the new key.
- Remove old key from both locations once clients have switched.

---

## deploy
```bash
pnpm wrangler deploy
```

your worker will be available at `https://<your-worker>.workers.dev`. 
---


