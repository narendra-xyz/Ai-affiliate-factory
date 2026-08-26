# n8n Integration (self-hosted Community Edition)

The backend never depends on n8n Cloud. n8n is an optional orchestration
layer that calls the backend's HTTP API and reports results back via
webhook. If n8n is down, the backend keeps working; only automated
scheduling stops.

## Authentication between n8n and the backend

All n8n → backend webhook calls must include the header:

```
x-n8n-token: <value of N8N_WEBHOOK_TOKEN from .env>
```

## Suggested workflows to build in n8n

### 1. Daily Content Pipeline (scheduled, e.g. every day at 09:00 WIB)
1. **Cron node** - trigger daily.
2. **HTTP Request** → `POST /api/products/hunt` (find new candidate products, capped by concurrency).
3. **HTTP Request** → `POST /api/videos/pipeline/trends` for top-scoring products.
4. **HTTP Request** → `POST /api/videos/pipeline/scripts`.
5. **HTTP Request** → `POST /api/videos/pipeline/critique-script`.
6. **IF node** - only continue if script status is `approved`.
7. **HTTP Request** → `POST /api/videos/pipeline/generate` (queued, concurrency-limited server-side).
8. **HTTP Request** → `POST /api/videos/pipeline/critique-video`.
9. **Webhook back to backend** → `POST /api/n8n/webhook/video-status` once external render/publish steps finish.

### 2. Performance Sync (scheduled, e.g. every 6 hours)
1. **Cron node**.
2. Pull metrics from each platform's API/affiliate dashboard (outside this repo's scope).
3. **HTTP Request** → `POST /api/n8n/webhook/performance-sync` with `{ videoId, date, views, clicks, orders, commission }`.

### 3. Resource Guard (scheduled, e.g. every 5 minutes)
1. **Cron node**.
2. **HTTP Request** → `GET /api/system/status`.
3. **IF node** - if `resources.ramUsedMb > resources.ramHardLimitMb`, send an alert
   (Telegram/WhatsApp/email node) so the operator can intervene manually.

## Notes
- All backend endpoints under `/api/*` (except `/api/auth/login` and `/api/n8n/*`)
  require a Bearer JWT. Generate one for n8n using the same login endpoint with a
  dedicated service account, or extend `auth.middleware.js` with an n8n-specific
  API key check if preferred.
- Keep n8n's own workflow concurrency low (1-2) to match the VPS's queue limits
  configured in `.env` (`MAX_VIDEO_CONCURRENCY`, `MAX_AGENT_CONCURRENCY`).
