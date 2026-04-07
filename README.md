# Comet

A proactive personal AI agent that communicates via iMessage (through [Linq](https://linq.so)) with Twilio SMS as a fallback. Comet reaches out to you before you even ask — checking your classes, email, calendar, and health data to surface what matters.

Multi-user from day one. Each user onboards via SMS, connects their own integrations, and gets a personalized experience.

---

## What it does

- **Morning briefs** — daily summary of assignments, emails, calendar events, weather, and transit alerts, sent at the user's preferred time and adapted based on reply engagement
- **Event reminders** — notifies you 30 minutes before upcoming calendar events
- **Canvas alerts** — flags assignments due soon, missing work, and grade changes
- **Email alerts** — proactively surfaces important and internship-related emails
- **Health nudges** — low-readiness or high-stress days with a packed schedule
- **Nightly digests** — end-of-day wrap-up after 4 hours of inactivity
- **Onboarding** — guided 9-step setup flow (name → Canvas → schedule → email → dorm → brief time)
- **Semantic memory** — remembers things you tell it via [Mem0](https://mem0.ai) cloud (LLM-based extraction, dedup, and search)
- **Browser automation** — delegates research and web tasks to a Playwright microservice
- **Account deletion** — text "delete my account" to receive a 6-digit code; confirmed deletion removes all data including memories

---

## Architecture overview

Comet is a **two-service platform**:

| Service | Directory | Default port | Purpose |
|---|---|---|---|
| **comet-core** | `/` | `3000` | Main AI agent — SMS handling, scheduling, memory, all integrations |
| **playwright-agent** | `playwright-agent/` | `3001` | Browser automation microservice — natural language → Playwright |

The two services communicate over HTTP with a shared `AGENT_SECRET`. They can be deployed independently — playwright-agent on Fly.io (config included), comet-core anywhere.

---

## Requirements

- Node.js 18+ (comet-core), Node.js 20+ (playwright-agent)
- PostgreSQL 14+
- [Mem0](https://app.mem0.ai) account — cloud semantic memory (free tier: 10k adds / 1k searches per month)
- Anthropic API key — used by both services
- Twilio account (required) + Linq account (optional, for iMessage)
- A public HTTPS URL (ngrok for local dev, a domain for production)
- [AgentOps](https://agentops.ai) API key (optional) — LLM observability

---

## Adding Users

No admin action required. Any phone number that texts the server is automatically enrolled in the onboarding flow. It runs entirely over SMS:

1. User texts the Twilio/Linq number
2. Comet introduces itself and asks for a name
3. User provides their Canvas URL and access token (instructions sent in-chat)
4. User describes their class schedule in plain text
5. User optionally connects Outlook and/or Gmail via OAuth links sent in-chat
6. User gives their dorm/location for bus tracking
7. User picks their morning brief time (or skips for the default 9am)
8. Onboarding complete — first brief scheduled for the next morning

**Each user is fully isolated.** All tokens, preferences, schedules, memories, and cron jobs are scoped per-user. One user connecting Gmail has zero effect on any other user.

After onboarding completes, `scheduleUserJobs(user)` fires automatically and creates five timezone-aware cron jobs: morning brief, early-class check, 10am Canvas/health alert, 9pm nightly digest, and 2:30am memory extraction.

**To add a second (or hundredth) user:** they text the number. Nothing else needed.

**To remove a user:** they text "delete my account" and confirm with the 6-digit code. All data is deleted — messages, preferences, memories, Graph subscriptions, cron jobs.

---

## Quick Start

### comet-core

```bash
git clone <repo>
cd comet
npm install
cp .env.example .env
# Fill in .env (see Environment Variables below)

createdb comet      # create the PostgreSQL database
npm start           # schema applied automatically on first run
```

### playwright-agent

```bash
cd playwright-agent
npm install
npx playwright install chromium   # one-time: downloads ~92 MB browser binary
cp .env.example .env
# Set ANTHROPIC_API_KEY and AGENT_SECRET (must match comet-core's AGENT_SECRET)
npm start
```

Both services support `npm run dev` for auto-restart on file changes.

---

## Environment Variables

### comet-core (`/.env`)

Copy `.env.example` to `.env`.

#### Core (required)

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://localhost:5432/comet` |
| `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com) |
| `MEM0_API_KEY` | From [app.mem0.ai](https://app.mem0.ai) → Settings → API Keys |

#### Observability (optional)

| Variable | Description |
|---|---|
| `AGENTOPS_API_KEY` | From [agentops.ai](https://agentops.ai) — enables LLM tracing (model, tokens, latency, cost per call). Silently disabled if absent. |

#### Messaging (Twilio required, Linq optional)

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | From [console.twilio.com](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | From Twilio console |
| `TWILIO_PHONE_NUMBER` | Your Twilio number in E.164 format |
| `LINQ_API_TOKEN` | Linq API token — leave blank to use Twilio only |
| `LINQ_PHONE_NUMBER` | Linq number (required if using Linq) |
| `LINQ_WEBHOOK_URL` | Public URL Linq delivers messages to, e.g. `https://yourdomain.com/webhook` |

#### Tuning

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `AGENT_NAME` | `Comet` | Agent's name used in the system prompt |
| `DAILY_MESSAGE_LIMIT` | `30` | Max outbound messages per user per day |
| `GLOBAL_DAILY_LIMIT` | `500` | Max total outbound messages across all users per day |

#### Registered agents

| Variable | Description |
|---|---|
| `PLAYWRIGHT_AGENT_URL` | Full base URL of the playwright-agent, e.g. `https://comet-playwright.fly.dev` — enables `GET /agents/status` probing and browser task delegation |

#### Microsoft Graph (optional — Outlook + Calendar)

Register an app at [portal.azure.com](https://portal.azure.com). Required scopes: `Mail.Read`, `Calendars.Read`, `offline_access`, `User.Read`.

| Variable | Description |
|---|---|
| `MICROSOFT_CLIENT_ID` | Azure app client ID |
| `MICROSOFT_CLIENT_SECRET` | Azure app client secret |
| `MICROSOFT_TENANT_ID` | Tenant ID — use `common` for multi-tenant |
| `MICROSOFT_REDIRECT_URI` | OAuth callback, e.g. `https://yourdomain.com/auth/microsoft/callback` |
| `WEBHOOK_BASE_URL` | Base URL for Graph change notification subscriptions |
| `WEBHOOK_SECRET` | Client state secret for validating Graph notifications |

#### Google (optional — Gmail + Calendar)

Enable Gmail API and Google Calendar API at [console.cloud.google.com](https://console.cloud.google.com). Create a Pub/Sub topic for Gmail push notifications.

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback, e.g. `https://yourdomain.com/auth/google/callback` |
| `GOOGLE_PUBSUB_TOPIC` | Pub/Sub topic, e.g. `projects/my-project/topics/gmail` |

#### Other integrations

| Variable | Description |
|---|---|
| `CANVAS_BASE_URL` | Default Canvas instance, e.g. `https://canvas.vt.edu` |
| `OPENWEATHERMAP_API_KEY` | From [openweathermap.org/api](https://openweathermap.org/api) |
| `SPOTIFY_CLIENT_ID` | From [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) |
| `SPOTIFY_CLIENT_SECRET` | Spotify client secret |
| `HEALTH_SYNC_SECRET` | Shared secret for iOS health sync POST to `/discord-digest` |
| `BT_GTFS_URL` | Blacksburg Transit GTFS static feed ZIP URL |
| `BT_REALTIME_TRIP_UPDATES_URL` | BT GTFS-RT trip updates protobuf URL |
| `BT_REALTIME_VEHICLE_POSITIONS_URL` | BT GTFS-RT vehicle positions protobuf URL |

---

### playwright-agent (`/playwright-agent/.env`)

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Used for Claude Haiku planning calls |
| `AGENT_SECRET` | — | **Required in production.** Shared Bearer token — must match what comet-core sends |
| `PORT` | `3001` | HTTP listen port |
| `PUBLIC_URL` | — | Public base URL shown in `/.well-known/agent.json`, e.g. `https://comet-playwright.fly.dev` |

---

## Database Setup

Schema is applied automatically on first `npm start` via `db.setup()`. All migrations use `IF NOT EXISTS` — safe to run on an existing database.

**Key tables:**

| Table | Purpose |
|---|---|
| `users` | One row per user; stores tokens, preferences, onboarding state |
| `messages` | Conversation history (user/assistant/system roles) |
| `sent_messages` | Outbound log; type-tagged for proactive dedup and feedback |
| `scheduled_messages` | Future messages queued by the AI |
| `morning_brief_engagement` | Per-brief reply tracking for adaptive verbosity |
| `pending_actions` | AI-proposed actions awaiting user confirmation |
| `user_preferences` | Per-trigger preference scores learned from feedback |
| `canvas_grade_snapshots` | Grade baselines for change detection |
| `global_daily_counts` | Daily global message cap counter |
| `health_readings` | Readiness scores synced from iOS |

To wipe and start fresh:

```bash
dropdb comet && createdb comet
npm start
```

---

## Running the Servers

```bash
# comet-core
npm start          # production
npm run dev        # development — auto-restarts on file changes
npm test           # run all tests (no live DB or APIs required)

# playwright-agent (separate terminal)
cd playwright-agent
npm start
npm run dev
```

On startup, comet-core:
1. Applies database schema migrations
2. Verifies Mem0 cloud connectivity
3. Downloads and parses GTFS bus route data
4. Renews Microsoft Graph webhook subscriptions
5. Renews Gmail Pub/Sub watch subscriptions
6. Registers the Linq inbound webhook (if configured)
7. Starts per-user timezone-aware cron jobs for all active users

On startup, playwright-agent:
1. Launches a persistent headless Chromium instance
2. Begins accepting tasks on `POST /tasks`

---

## Deploying to Production

### comet-core pre-deploy checklist

**Must have (nothing works without these):**
- PostgreSQL database with `DATABASE_URL` set
- `ANTHROPIC_API_KEY` — all AI responses fail without it
- `MEM0_API_KEY` — memory silently disabled without it, but the server still runs
- Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`)
- A public HTTPS URL so webhooks can reach the server

**Must set after you know your public URL:**
- `LINQ_WEBHOOK_URL` = `https://yourdomain.com/webhook`
- `WEBHOOK_BASE_URL` = `https://yourdomain.com`
- `MICROSOFT_REDIRECT_URI` = `https://yourdomain.com/auth/microsoft/callback`
- `GOOGLE_REDIRECT_URI` = `https://yourdomain.com/auth/google/callback`

**Must configure in provider dashboards:**
- Twilio console → phone number → Messaging webhook → `https://yourdomain.com/webhook` (POST)
- Gmail Pub/Sub subscription → push endpoint → `https://yourdomain.com/gmail-webhook`
- Microsoft Graph subscriptions are managed automatically by the server

**Optional — features degrade gracefully without them:**
- `AGENTOPS_API_KEY` — tracing disabled but everything else works
- `CANVAS_BASE_URL` — Canvas integration won't work during onboarding if absent
- Spotify, OpenWeatherMap, Blacksburg Transit — those features just won't fire
- `PLAYWRIGHT_AGENT_URL` — browser delegation unavailable; `/agents/status` returns an empty list

---

### Railway (recommended for comet-core)

1. Push the repo to GitHub
2. Create a new Railway project → Deploy from GitHub repo
3. Add a PostgreSQL plugin (Railway sets `DATABASE_URL` automatically)
4. In Variables, add every key from `.env.example` with real values
5. After the first deploy completes, copy the generated domain and update:
   - `LINQ_WEBHOOK_URL` = `https://<domain>/webhook`
   - `WEBHOOK_BASE_URL` = `https://<domain>`
   - `MICROSOFT_REDIRECT_URI` = `https://<domain>/auth/microsoft/callback`
   - `GOOGLE_REDIRECT_URI` = `https://<domain>/auth/google/callback`
6. Redeploy so the server picks up the corrected URLs
7. In Twilio console, set the phone number's messaging webhook to `https://<domain>/webhook`
8. In Gmail Pub/Sub, create a push subscription pointing to `https://<domain>/gmail-webhook`
9. Healthcheck URL: `https://<domain>/health`
10. Once playwright-agent is deployed (below), set `PLAYWRIGHT_AGENT_URL=https://comet-playwright.fly.dev`

---

### Fly.io (playwright-agent)

The playwright-agent ships with a `Dockerfile` and `fly.toml` pre-configured for Fly.io. It scales to zero when idle and wakes on the first request.

```bash
cd playwright-agent

# One-time setup
fly auth login
fly apps create comet-playwright

# Set secrets
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  AGENT_SECRET=your-shared-secret \
  PUBLIC_URL=https://comet-playwright.fly.dev

# Deploy
fly deploy
```

The included `fly.toml` configures:
- **1 shared CPU, 1 GB RAM** — minimum for stable headless Chromium
- **Scale to zero** after ~5 minutes of inactivity (`auto_stop_machines = 'stop'`)
- **Auto-wake** on the first incoming request (`auto_start_machines = true`)
- Health check on `GET /health` every 30 seconds

After deploying, set `PLAYWRIGHT_AGENT_URL=https://comet-playwright.fly.dev` in comet-core's environment and redeploy.

To verify both services are reachable from comet-core:

```bash
curl https://<comet-domain>/agents/status
# → { "agents": [{ "name": "playwright-agent", "online": true, "activeTasks": 0 }], "online": 1 }
```

---

### Render / Fly.io (comet-core)

Same steps as Railway. Render auto-detects `npm start` from `package.json`. Set `NODE_ENV=production`.

---

### VPS (Ubuntu/Debian)

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres createdb comet

# Clone and configure comet-core
git clone <repo> /opt/comet
cd /opt/comet
npm ci --omit=dev
cp .env.example .env
nano .env          # fill in all required values

# Run with PM2
npm install -g pm2
pm2 start src/index.js --name comet
pm2 save
pm2 startup        # follow the printed command to enable on boot

# playwright-agent (same server or separate)
cd /opt/comet/playwright-agent
npm ci --omit=dev
npx playwright install chromium --with-deps
cp .env.example .env
nano .env
pm2 start index.js --name comet-playwright
pm2 save

# Nginx + HTTPS (required for webhooks)
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

**Nginx config** (`/etc/nginx/sites-available/comet`):

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    # comet-core
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl;
    server_name playwright.yourdomain.com;

    # playwright-agent (only needed if not using Fly.io)
    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

After the domain is live, set `LINQ_WEBHOOK_URL`, `WEBHOOK_BASE_URL`, the OAuth redirect URIs, and `PLAYWRIGHT_AGENT_URL` in `.env`, then `pm2 restart comet`.

---

### Local development with ngrok

```bash
# Terminal 1 — comet-core
npm run dev

# Terminal 2 — playwright-agent
cd playwright-agent && npm run dev

# Terminal 3 — expose comet-core
ngrok http 3000
# Copy the https:// URL, then set in .env:
#   LINQ_WEBHOOK_URL=https://<ngrok-id>.ngrok.io/webhook
#   WEBHOOK_BASE_URL=https://<ngrok-id>.ngrok.io
#   MICROSOFT_REDIRECT_URI=https://<ngrok-id>.ngrok.io/auth/microsoft/callback
#   GOOGLE_REDIRECT_URI=https://<ngrok-id>.ngrok.io/auth/google/callback
```

---

## API Reference

### comet-core endpoints

| Path | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | — | Status, uptime, active messaging provider |
| `/agents/status` | GET | — | Health-checks all registered agent microservices |
| `/webhook` | POST | HMAC / Twilio sig | Inbound SMS/iMessage — handles both Linq and Twilio |
| `/graph-webhook` | GET + POST | Graph secret | Microsoft Graph change notifications |
| `/gmail-webhook` | POST | Pub/Sub | Gmail push notifications |
| `/discord-digest` | POST | `HEALTH_SYNC_SECRET` | iOS Shortcut health data sync |
| `/auth/microsoft` | GET | — | Microsoft OAuth callback |
| `/auth/google` | GET | — | Google OAuth callback |

### playwright-agent endpoints

| Path | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | — | `{ status: 'ok', activeTasks: N }` |
| `/.well-known/agent.json` | GET | — | Agent identity card (name, version, capabilities, endpoint) |
| `/tasks` | POST | Bearer `AGENT_SECRET` | Submit a browser task — returns `{ taskId, status: 'running' }` immediately |
| `/tasks/:taskId` | GET | Bearer `AGENT_SECRET` | Poll task status and retrieve results/screenshots |
| `/tasks/:taskId/cancel` | POST | Bearer `AGENT_SECRET` | Cancel a running or queued task |

**POST /tasks body:**

```json
{
  "taskId":      "unique-id",
  "description": "Navigate to example.com and scrape the page title",
  "context":     "optional extra context for the planner",
  "userId":      "user-42"
}
```

**Task status lifecycle:** `pending` → `running` → `done` | `error` | `cancelled`

The agent runs up to **5 tasks concurrently**. Additional tasks are queued and start automatically as slots free up. Each task has a **90-second hard timeout**; a JPEG screenshot is captured on error.

**SSRF protection:** `navigate` steps targeting `localhost`, `127.x.x.x`, `10.x.x.x`, `192.168.x.x`, or link-local addresses are blocked before Playwright touches the network.

---

## Webhook Configuration

| Path | Method | Provider | Notes |
|---|---|---|---|
| `/webhook` | POST | Twilio | Set in Twilio console under the phone number's messaging webhook |
| `/webhook` | POST | Linq | Registered automatically on startup via `registerLinqWebhook` |
| `/graph-webhook` | GET + POST | Microsoft Graph | URL derived from `WEBHOOK_BASE_URL`; subscriptions auto-renewed daily |
| `/gmail-webhook` | POST | Google Pub/Sub | Push subscription endpoint; watches auto-renewed every 6 days |
| `/discord-digest` | POST | iOS Shortcut | Secured with `HEALTH_SYNC_SECRET` header |
| `/auth/microsoft` | GET | Microsoft OAuth | Must match `MICROSOFT_REDIRECT_URI` exactly |
| `/auth/google` | GET | Google OAuth | Must match `GOOGLE_REDIRECT_URI` exactly |
| `/health` | GET | — | Healthcheck; returns 200 |

**Rate limits** (all skipped in `NODE_ENV=test`):
- `/webhook`: 60 requests/minute per sender phone number
- `/graph-webhook`, `/gmail-webhook`: 10 requests/minute per IP
- OAuth callbacks: 20 requests/15 minutes per IP

---

## Features

### AgentOps observability

Every Anthropic API call is traced automatically when `AGENTOPS_API_KEY` is set. Traces are emitted from `src/utils/claude.js` as a side effect of every `generateUserMessage` and `classify` call. Each trace captures:

- Model used
- Input and output token counts
- Latency in milliseconds
- `userId` as metadata (when available)

View traces at [app.agentops.ai](https://app.agentops.ai). Entirely optional — silently disabled if the key is absent.

---

### Model router

`src/models/router.js` maps task types to cost-appropriate models. Every `generateUserMessage` and `classify` call in `src/utils/claude.js` accepts an optional `taskType` that picks the model automatically.

| Task type | Model | Used for |
|---|---|---|
| `conversation` | claude-sonnet-4-6 | Main chat replies (default) |
| `coding_complex` | claude-sonnet-4-6 | Complex code tasks |
| `proactive` | claude-haiku-4-5-20251001 | Drafting proactive messages |
| `brief_build` | claude-haiku-4-5-20251001 | Constructing morning briefs |
| `classification` | claude-haiku-4-5-20251001 | Intent detection, extraction (default for `classify()`) |
| `research` | gemini-2.0-flash-exp | Research tasks |
| `browser_planning` | gemini-2.0-flash-exp | Browser automation planning |
| `coding_simple` | gemini-2.0-flash-exp | Simple code tasks |

Any unknown `taskType` falls back to `claude-sonnet-4-6`. The main conversation path in `brain.js` is unchanged — it always uses Sonnet.

**Estimated daily cost** (15 proactive messages + 5 conversations per user):

| Scenario | Est. cost/day |
|---|---|
| Before routing — Sonnet for everything | ~$0.18 |
| After routing — Haiku for proactive/classification, Sonnet for conversation | ~$0.04 |

> ~500 tokens in / ~200 out per proactive message; ~1500 in / ~400 out per conversation. April 2026 API rates.

---

### Mem0 cloud memory

`src/memory/store.js` uses the official [`mem0ai`](https://www.npmjs.com/package/mem0ai) SDK (`MemoryClient`) backed by Mem0's managed cloud. Mem0 handles storage, embedding, deduplication, and LLM-based memory consolidation automatically.

The public API — `storeMemory`, `searchMemories`, `deleteUserMemories` — is unchanged. Nightly extraction in `extract.js` calls `storeMemory` exactly as before; Mem0 handles the rest. If the Mem0 API is unreachable, all operations log the error and return gracefully without interrupting the conversation.

**Pricing** (April 2026):

| Tier | Monthly cost | Adds | Searches |
|---|---|---|---|
| Hobby | Free | 10,000 | 1,000 |
| Starter | $19 | 50,000 | 5,000 |
| Pro | $249 | 500,000 | 50,000 |

The free tier covers personal use with a handful of users.

---

### Playwright browser agent

A standalone Node.js microservice in `playwright-agent/` that accepts natural-language task descriptions, uses Claude Haiku to plan browser steps, executes them in Playwright, and returns structured results plus screenshots.

**Flow:**

1. POST a natural-language description to `POST /tasks`
2. Claude Haiku translates it into a JSON action plan (navigate, click, type, scrape, scroll, screenshot, wait)
3. Playwright executes each step in a headless Chromium page
4. Results and screenshots are stored in memory, retrievable via `GET /tasks/:taskId`

**Example:**

```bash
# Submit
curl -X POST https://comet-playwright.fly.dev/tasks \
  -H "Authorization: Bearer $AGENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "hn-scrape-1",
    "userId": "user-42",
    "description": "Go to news.ycombinator.com and scrape the titles of the top 5 stories"
  }'
# → { "taskId": "hn-scrape-1", "status": "running" }

# Poll
curl https://comet-playwright.fly.dev/tasks/hn-scrape-1 \
  -H "Authorization: Bearer $AGENT_SECRET"
# → { "taskId": "hn-scrape-1", "status": "done", "result": { "results": [...] } }
```

---

## Integration Setup Details

### Canvas LMS

Users provide their Canvas base URL and access token during onboarding. No server-side credential needed.

To get a token: `<canvas-url>/profile/settings` → Approved Integrations → New Access Token.

### Microsoft Graph

1. [portal.azure.com](https://portal.azure.com) → Azure Active Directory → App registrations → New registration
2. Add redirect URI: `https://yourdomain.com/auth/microsoft`
3. API permissions: `Mail.Read`, `Calendars.Read`, `offline_access`, `User.Read` (all Delegated)
4. Create a client secret under Certificates & secrets
5. Copy client ID, secret, and tenant ID into `.env`

### Google

1. [console.cloud.google.com](https://console.cloud.google.com) → New project → APIs & Services
2. Enable: Gmail API, Google Calendar API, Cloud Pub/Sub API
3. OAuth consent screen → External → add scopes: `gmail.readonly`, `calendar.readonly`
4. Credentials → Create OAuth 2.0 Client ID (Web application) → add redirect URI
5. Pub/Sub → Create topic → Create push subscription → endpoint: `https://yourdomain.com/gmail-webhook`
6. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic

### Mem0

1. Sign up at [app.mem0.ai](https://app.mem0.ai)
2. Settings → API Keys → Create key
3. Set `MEM0_API_KEY` in `.env`

That's it. No collection setup, no vector config, no infrastructure. Mem0 creates a default project automatically.

### AgentOps

1. Sign up at [agentops.ai](https://agentops.ai) and create a project
2. Copy the API key to `AGENTOPS_API_KEY` in `.env`
3. Restart the server — traces appear in the dashboard immediately

Tracing is purely additive. Removing the env var disables it with no other effect.

---

## Feature Reference

### Onboarding

Any new phone number that texts the server is automatically enrolled. The 9-step flow runs entirely over SMS — no admin action, no invite link, no dashboard.

| Step | What happens |
|---|---|
| 0 | Agent introduces itself, asks for name |
| 1 | Name extracted with Claude (falls back to first word) |
| 2 | Canvas URL collected and validated for domain format |
| 3 | Canvas token collected and verified live against the Canvas API |
| 4 | Class schedule entered in free text ("MWF 10am Algorithms in McBryde") |
| 5 | Email opt-in — Outlook and Gmail OAuth links sent, or user skips |
| 6 | User connects email(s) via browser, replies "done" |
| 7 | Dorm or apartment entered for nearest bus stop lookup |
| 8 | Morning brief time set ("8am", "8:30", or skip for 9am default) |
| 9 | `onboarding_complete = true` — five per-user cron jobs started |

### Morning Brief Time Preference

Accepted formats: `8am`, `8:30am`, `9`, `9:30`, `08:00`. Clamped to 6am–11am.

If a class starts at or before the preferred time, the brief is sent one hour before that class (minimum 6am).

### Proactive Message Gating

Every proactive message type is filtered through:
- Quiet hours (12am–7am local time)
- In-class check
- Already sent today (per type)
- Daily limit: 8 proactive messages/day
- Preference ratio: suppresses a type if the user ignores it >60% of the time (requires 5+ samples)

Important email alerts bypass the daily limit but still respect quiet hours.

### Account Deletion

Trigger phrases: "delete my account", "delete account", "remove my account", "stop texting me", "unsubscribe", "delete my data", "remove me", "opt out".

A 6-digit confirmation code is sent via SMS (expires 10 minutes). On confirmation:
- Per-user cron jobs stopped
- Microsoft Graph subscription cancelled
- Mem0 cloud memories deleted (`deleteAll` scoped to `user_id`)
- User row CASCADE deleted (messages, preferences, schedules all removed)

### Conversation Gap Awareness

If a user hasn't texted in more than 12 hours, brain.js injects context so the AI can acknowledge the gap naturally:
- 12–24h: "user hasn't texted since yesterday"
- 1–3 days: "user hasn't texted in N days"
- 3+ days: adds a note to acknowledge it warmly

---

## Running Tests

```bash
npm test                 # all tests
npm run test:watch       # watch mode
npm run test:coverage    # with coverage report
```

511 tests across 25 suites. No live database or external API calls required — everything runs with mocks.

| Suite | What it tests |
|---|---|
| `tests/memory/store.test.js` | Mem0 `MemoryClient` integration — add, search, delete, error handling, v1/v2 response normalisation |
| `tests/briefPreference.test.js` | `parseBriefTime` formats, `getEffectiveBriefHour` logic |
| `tests/briefQuality.test.js` | `buildMorningBriefPrompt` (classes, canvas, weather, engagement hints) |
| `tests/deletion.test.js` | `isDeletionRequest` phrases, deletion flow, code validation |
| `tests/gapAwareness.test.js` | `getGapContext` values including 12h boundary |
| `tests/scheduling.test.js` | Per-user cron creation, timezone options, job replacement |
| `tests/brain.test.js` | Response generation, action parsing, history compaction |
| `tests/sms.test.js` | Linq vs Twilio routing, HMAC verification, fallback behavior |
| `tests/onboarding.test.js` | All 9 onboarding steps, validation, fallback paths |
| `tests/integration/onboarding.test.js` | Full HTTP flow via supertest |
| `tests/db.test.js` | All DB functions |

---

## File Structure

```
/                              comet-core
  src/
    index.js                   Express server, webhooks, rate limiting, OAuth,
                               /agents/status registry
    brain.js                   AI response, gap detection, action parsing, history compaction
    scheduler.js               Per-user timezone-aware crons, morning brief, nightly planning
    proactive.js               Proactive trigger engine with confidence gating
    onboarding.js              9-step SMS setup flow
    briefTime.js               Morning brief time preference parsing
    deletion.js                Account deletion with 6-digit confirmation
    sms.js                     Linq (iMessage) + Twilio, rate limiting, typing indicators
    db.js                      PostgreSQL via pg pool
    soul.md                    Agent personality / system prompt
    models/
      router.js                Task type → model name (Sonnet / Haiku / Gemini)
    integrations/
      canvas.js                Canvas LMS assignments, grades, announcements
      outlook.js               Microsoft Graph email, calendar, webhook subscriptions
      gmail.js                 Gmail, Google Calendar, Pub/Sub, Venmo parsing
      spotify.js               Spotify mood context
      weather.js               OpenWeatherMap forecasts
      schedule.js              Class schedule storage and in-class detection
      bt_static.js             Blacksburg Transit GTFS static routes
      bt_bus.js                BT real-time arrivals and leave-now alerts
      discord.js               iOS Shortcut health sync
    memory/
      store.js                 Mem0 cloud — add, search, delete via MemoryClient
      extract.js               Nightly memory extraction from conversation history
    learning/
      styleAnalyzer.js         Communication style learning
      feedbackCapture.js       Proactive message feedback loop
      patternExtractor.js      Interaction pattern analysis
    utils/
      claude.js                Anthropic API helpers + AgentOps tracing + model router
      cache.js                 In-memory TTL cache
      limiter.js               Per-user daily message rate limiting
  .env.example
  railway.toml

playwright-agent/              Browser automation microservice
  index.js                     Express server, routes, task lifecycle, auth middleware
  browser.js                   Chromium singleton with auto-relaunch on disconnect
  planner.js                   Claude Haiku → JSON action plan
  executor.js                  Step-by-step Playwright execution + SSRF guard
  tasks.js                     In-memory task Map + 5-slot concurrency queue
  .env.example
  Dockerfile                   Node 20 Alpine + system Chromium
  fly.toml                     Fly.io: 1 shared CPU, 1 GB RAM, scale-to-zero
```
