# Comet

A proactive personal AI agent that communicates via iMessage (through [Linq](https://linq.so)) with Twilio SMS as a fallback. Comet reaches out to you before you even ask — checking your classes, email, calendar, and health data to surface what matters.

Multi-user from day one. Each user onboards via SMS, connects their own integrations, and gets a personalized experience.

## What it does

- **Morning briefs** — daily summary of assignments, emails, calendar events, weather, and transit alerts, sent at the user's preferred time and adapted based on reply engagement
- **Event reminders** — notifies you 30 minutes before upcoming calendar events
- **Canvas alerts** — flags assignments due soon, missing work, and grade changes
- **Email alerts** — proactively surfaces important and internship-related emails
- **Health nudges** — low-readiness or high-stress days with a packed schedule
- **Nightly digests** — end-of-day wrap-up after 4 hours of inactivity
- **Onboarding** — guided 9-step setup flow (name → Canvas → schedule → email → dorm → brief time)
- **Semantic memory** — remembers things you tell it via Qdrant vector search
- **Account deletion** — text "delete my account" to receive a 6-digit code; confirmed deletion removes all data including memories

---

## Requirements

- Node.js 18+
- PostgreSQL 14+
- [Qdrant](https://qdrant.tech) (local Docker or cloud)
- Anthropic API key
- Twilio account (required) + Linq account (optional, for iMessage)
- A public HTTPS URL (ngrok for local dev, a domain for production)

---

## Adding Users

No admin action is required to add a user. Any new phone number that texts the server is automatically enrolled in onboarding. The 9-step flow happens entirely over SMS:

1. User texts the Twilio/Linq number
2. Comet introduces itself and asks for a name
3. User provides their Canvas URL and access token (in-chat instructions)
4. User describes their class schedule in plain text
5. User optionally connects Outlook and/or Gmail via OAuth links sent in-chat
6. User gives their dorm/location for bus tracking
7. User picks their morning brief time (or skips for the default 9am)
8. Onboarding complete — first brief is scheduled for the next morning

**Each user is fully isolated.** All tokens, preferences, schedules, memories, and cron jobs are per-user. One user connecting Gmail has zero effect on other users. Per-user cron jobs run in the user's own timezone.

After onboarding completes, `scheduleUserJobs(user)` is called automatically (triggered on the first webhook after `onboarding_complete = true`). The user gets five cron jobs tied to their timezone: morning brief, early-class check, 10am Canvas/health alert, 9pm nightly digest, and 2:30am memory extraction.

**To add a second (or hundredth) user:** they text the number. Nothing else needed.

**To remove a user:** they text "delete my account" and confirm the 6-digit code. All their data is deleted automatically — messages, preferences, memories, Graph subscriptions, cron jobs.

---

## Quick Start

```bash
git clone <repo>
cd comet
npm install
cp .env.example .env
# Fill in .env (see Environment Variables below)

createdb comet      # create the PostgreSQL database
npm start           # schema applied automatically on first run
```

---

## Environment Variables

Copy `.env.example` to `.env`. Required variables are marked.

### Core (required)

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://localhost:5432/comet` |
| `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | For text embeddings ([platform.openai.com](https://platform.openai.com)) |
| `QDRANT_URL` | Qdrant URL, e.g. `http://localhost:6333` or cloud URL |

### Messaging (Twilio required, Linq optional)

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | From [console.twilio.com](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | From Twilio console |
| `TWILIO_PHONE_NUMBER` | Your Twilio number in E.164 format |
| `LINQ_API_TOKEN` | Linq API token — leave blank to use Twilio only |
| `LINQ_PHONE_NUMBER` | Linq number (required if using Linq) |
| `LINQ_WEBHOOK_URL` | Public URL Linq delivers messages to, e.g. `https://yourdomain.com/webhook` |

### Tuning

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `AGENT_NAME` | `Comet` | Agent's name used in the system prompt |
| `DAILY_MESSAGE_LIMIT` | `30` | Max outbound messages per user per day |
| `GLOBAL_DAILY_LIMIT` | `500` | Max total outbound messages across all users per day |

### Microsoft Graph (optional — Outlook + Calendar)

Register an app at [portal.azure.com](https://portal.azure.com). Required scopes: `Mail.Read`, `Calendars.Read`, `offline_access`, `User.Read`.

| Variable | Description |
|---|---|
| `MICROSOFT_CLIENT_ID` | Azure app client ID |
| `MICROSOFT_CLIENT_SECRET` | Azure app client secret |
| `MICROSOFT_TENANT_ID` | Tenant ID, use `common` for multi-tenant |
| `MICROSOFT_REDIRECT_URI` | OAuth callback, e.g. `https://yourdomain.com/auth/microsoft/callback` |
| `WEBHOOK_BASE_URL` | Base URL for Graph change notification subscriptions |
| `WEBHOOK_SECRET` | Client state secret for validating Graph notifications |

### Google (optional — Gmail + Calendar)

Enable Gmail API and Google Calendar API at [console.cloud.google.com](https://console.cloud.google.com). Create a Pub/Sub topic for Gmail push notifications.

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback, e.g. `https://yourdomain.com/auth/google/callback` |
| `GOOGLE_PUBSUB_TOPIC` | Pub/Sub topic, e.g. `projects/my-project/topics/gmail` |

### Other Integrations

| Variable | Description |
|---|---|
| `QDRANT_API_KEY` | Qdrant API key (cloud only, omit for self-hosted) |
| `CANVAS_BASE_URL` | Default Canvas instance, e.g. `https://canvas.vt.edu` |
| `OPENWEATHERMAP_API_KEY` | From [openweathermap.org/api](https://openweathermap.org/api) |
| `SPOTIFY_CLIENT_ID` | From [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) |
| `SPOTIFY_CLIENT_SECRET` | Spotify client secret |
| `HEALTH_SYNC_SECRET` | Shared secret for iOS health sync POST to `/discord-digest` |
| `BT_GTFS_URL` | Blacksburg Transit GTFS static feed ZIP URL |
| `BT_REALTIME_TRIP_UPDATES_URL` | BT GTFS-RT trip updates protobuf URL |
| `BT_REALTIME_VEHICLE_POSITIONS_URL` | BT GTFS-RT vehicle positions protobuf URL |

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

## Running the Server

```bash
npm start          # production
npm run dev        # development — auto-restarts on file changes
npm test           # run all tests (no live DB or APIs required)
```

On startup the server:
1. Applies database schema migrations
2. Initializes the Qdrant memory collection
3. Downloads and parses GTFS bus route data
4. Renews Microsoft Graph webhook subscriptions
5. Renews Gmail Pub/Sub watch subscriptions
6. Registers the Linq inbound webhook (if Linq is configured)
7. Starts per-user timezone-aware cron jobs for all active users

---

## Deploying to Production

### What you need before deploying

Before the server can start and accept users, you need these in place:

**Must have (nothing works without these):**
- PostgreSQL database with `DATABASE_URL` set
- `ANTHROPIC_API_KEY` — all responses fail without it
- `OPENAI_API_KEY` + `QDRANT_URL` — memory is silently disabled but the server still runs
- Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`)
- A public HTTPS URL so webhooks can reach the server

**Must set after you know your public URL:**
- `LINQ_WEBHOOK_URL` = `https://yourdomain.com/webhook` — also used as the Twilio webhook URL
- `WEBHOOK_BASE_URL` = `https://yourdomain.com` — for Microsoft Graph subscriptions
- `MICROSOFT_REDIRECT_URI` = `https://yourdomain.com/auth/microsoft/callback`
- `GOOGLE_REDIRECT_URI` = `https://yourdomain.com/auth/google/callback`

**Must configure in provider dashboards:**
- Twilio console → phone number → Messaging webhook → set to `https://yourdomain.com/webhook` (POST)
- Gmail Pub/Sub subscription → push endpoint → `https://yourdomain.com/gmail-webhook`
- Microsoft Graph subscriptions are managed automatically by the server

**Optional (features degrade gracefully without them):**
- `CANVAS_BASE_URL` — Canvas integration won't work during onboarding if absent
- Spotify, OpenWeatherMap, Blacksburg Transit — those features just won't fire

### Railway (recommended)

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

### Render / Fly.io

Same as Railway. Render auto-detects `npm start` from `package.json`. Set `NODE_ENV=production`.

### VPS (Ubuntu/Debian)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib
sudo -u postgres createdb comet

# Clone and configure
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

# Nginx + HTTPS (required for webhooks)
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

**Nginx config** (`/etc/nginx/sites-available/comet`):

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

After the domain is live: set `LINQ_WEBHOOK_URL`, `WEBHOOK_BASE_URL`, and OAuth redirect URIs in `.env`, then `pm2 restart comet`.

### Local Development with ngrok

```bash
npm install -g ngrok
ngrok http 3000
# Copy the https:// URL, then set in .env:
#   LINQ_WEBHOOK_URL=https://<ngrok-id>.ngrok.io/webhook
#   WEBHOOK_BASE_URL=https://<ngrok-id>.ngrok.io
#   MICROSOFT_REDIRECT_URI=https://<ngrok-id>.ngrok.io/auth/microsoft/callback
#   GOOGLE_REDIRECT_URI=https://<ngrok-id>.ngrok.io/auth/google/callback
npm run dev
```

---

## Webhook Configuration

All webhooks are registered/configured through the provider dashboards.

| Path | Method | Provider | Notes |
|---|---|---|---|
| `/webhook` | POST | Twilio | Set in Twilio console under the phone number's messaging webhook |
| `/webhook` | POST | Linq | Registered automatically on startup via `registerLinqWebhook` |
| `/graph-webhook` | GET + POST | Microsoft Graph | URL set in `WEBHOOK_BASE_URL`; auto-renewed daily |
| `/gmail-webhook` | POST | Google Pub/Sub | Push subscription endpoint; auto-renewed every 6 days |
| `/discord-digest` | POST | iOS Shortcut | Secured with `HEALTH_SYNC_SECRET` header |
| `/auth/microsoft/callback` | GET | Microsoft OAuth | Must match `MICROSOFT_REDIRECT_URI` exactly |
| `/auth/google/callback` | GET | Google OAuth | Must match `GOOGLE_REDIRECT_URI` exactly |
| `/health` | GET | — | Healthcheck; returns 200 |

**Rate limits** (all skipped in `NODE_ENV=test`):
- `/webhook`: 60 requests/minute per sender phone number
- `/graph-webhook`, `/gmail-webhook`: 10 requests/minute per IP
- OAuth callbacks: 5 requests/15 minutes per IP

---

## Integration Setup Details

### Canvas LMS

Users provide their Canvas base URL and access token during onboarding. No server-side credential needed.

To get a Canvas token: `<canvas-url>/profile/settings` → Approved Integrations → New Access Token.

### Microsoft Graph

1. [portal.azure.com](https://portal.azure.com) → Azure Active Directory → App registrations → New registration
2. Add redirect URI: `https://yourdomain.com/auth/microsoft/callback`
3. API permissions: `Mail.Read`, `Calendars.Read`, `offline_access`, `User.Read` (all Delegated)
4. Create a client secret under Certificates & secrets
5. Copy client ID, secret, and tenant ID into `.env`

### Google

1. [console.cloud.google.com](https://console.cloud.google.com) → New project → APIs & Services
2. Enable: Gmail API, Google Calendar API, Cloud Pub/Sub API
3. OAuth consent screen → External → add scopes: `gmail.readonly`, `calendar.readonly`
4. Credentials → Create OAuth 2.0 client ID (Web application) → add redirect URI
5. Pub/Sub → Create topic → Create push subscription → endpoint: `https://yourdomain.com/gmail-webhook`
6. Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic

### Qdrant (self-hosted)

```bash
docker run -d -p 6333:6333 --name qdrant qdrant/qdrant
# Set QDRANT_URL=http://localhost:6333
```

The `memories` collection is created automatically on startup.

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
| 8 | Morning brief time preference set ("8am", "8:30", or skip for default 9am) |
| 9 | `onboarding_complete = true` — five per-user cron jobs started, first brief scheduled |

After step 9, `scheduleUserJobs` creates timezone-aware cron jobs for morning brief, early-class brief, 10am Canvas/health check, 9pm nightly digest, and 2:30am memory extraction.

### Morning Brief Time Preference

During onboarding step 8 (the last step), users choose their preferred brief time. Accepted formats: `8am`, `8:30am`, `9`, `9:30`, `08:00`. Clamped to 6am–11am.

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

Text any of: "delete my account", "delete account", "remove my account", "stop texting me", "unsubscribe", "delete my data", "remove me", "opt out".

A 6-digit confirmation code is sent via SMS (expires in 10 minutes). On confirmation:
- Per-user cron jobs stopped
- Microsoft Graph subscription cancelled
- Qdrant vector memories deleted
- User row CASCADE deleted (messages, preferences, schedules all removed)

### Conversation Gap Awareness

If a user hasn't texted in more than 12 hours, brain.js injects context into the system prompt so the AI can acknowledge the gap naturally:
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

508 tests across 25 suites. No live database or external API calls required — all tests run entirely with mocks.

| Suite | What it tests |
|---|---|
| `tests/briefPreference.test.js` | `parseBriefTime` formats, `getEffectiveBriefHour` logic |
| `tests/briefQuality.test.js` | `buildMorningBriefPrompt` logic (classes, canvas, weather, engagement hints) |
| `tests/deletion.test.js` | `isDeletionRequest` phrases, deletion flow, code validation |
| `tests/gapAwareness.test.js` | `getGapContext` return values including boundary at 12h |
| `tests/scheduling.test.js` | Per-user cron creation, timezone options, job replacement |
| `tests/brain.test.js` | Response generation, action parsing, history compaction |
| `tests/sms.test.js` | Linq vs Twilio routing, HMAC verification, fallback behavior |
| `tests/onboarding.test.js` | All 9 onboarding steps, validation, fallback paths |
| `tests/integration/onboarding.test.js` | Full HTTP flow via supertest |
| `tests/db.test.js` | All DB functions including new brief/deletion/engagement functions |

---

## Architecture

```
src/
  index.js           — Express server, webhook routing, rate limiting, OAuth callbacks
  brain.js           — AI response, gap detection, action parsing, history compaction
  scheduler.js       — Per-user timezone-aware crons, morning brief, nightly planning
  proactive.js       — Proactive trigger engine with confidence gating
  onboarding.js      — 9-step guided setup flow
  briefTime.js       — Morning brief time preference parsing and effective-hour calculation
  deletion.js        — Account deletion with 6-digit confirmation
  sms.js             — Linq (iMessage) + Twilio, rate limiting, typing indicators
  db.js              — PostgreSQL via pg pool — all database access
  soul.md            — Agent personality / system prompt
  integrations/
    canvas.js        — Canvas LMS assignments, grades, announcements
    outlook.js       — Microsoft Graph email, calendar, webhook subscriptions
    gmail.js         — Gmail, Google Calendar, Pub/Sub webhook, Venmo parsing
    spotify.js       — Spotify mood context
    weather.js       — OpenWeatherMap forecasts
    schedule.js      — Class schedule storage and in-class detection
    bt_static.js     — Blacksburg Transit GTFS static routes
    bt_bus.js        — BT real-time arrivals and leave-now alerts
    discord.js       — iOS Shortcut health sync
  memory/
    store.js         — Qdrant vector store (search, store, delete)
    extract.js       — Nightly memory extraction from conversations
    embeddings.js    — OpenAI text embeddings
  learning/
    styleAnalyzer.js      — Communication style learning
    feedbackCapture.js    — Proactive message feedback loop
    patternExtractor.js   — Interaction pattern analysis
  utils/
    claude.js        — Anthropic API helpers (generateUserMessage + classify)
    cache.js         — In-memory TTL cache
    limiter.js       — Per-user daily message rate limiting
```
