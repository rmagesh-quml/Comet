'use strict';

require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');
const db = require('./db');
const { getResponse } = require('./brain');
const {
  isLinqAvailable,
  isTelegramAvailable,
  verifyLinqWebhook,
  verifyTelegramWebhook,
  registerLinqWebhook,
  registerTelegramWebhook,
  sendMessage,
  detectAndUpdateMessagingService,
} = require('./sms');
const { scheduleAllJobs } = require('./scheduler');
const { graphWebhookHandler, renewWebhookSubscriptions } = require('./integrations/outlook');
const { handleGmailNotification, renewGmailWatches } = require('./integrations/gmail');
const { handleDiscordDigest } = require('./integrations/discord');
const { downloadAndParseGTFS } = require('./integrations/bt_static');
const { initQdrant } = require('./memory/store');
const { handleOnboardingMessage } = require('./onboarding');
const { confirmDeletion } = require('./deletion');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory deduplication set for Linq message IDs
const processedIds = new Set();

// ─── Rate limiters ────────────────────────────────────────────────────────────

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.body?.data?.from || req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  validate: false,
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  validate: false,
  keyGenerator: (req) => req.ip,
  skip: () => process.env.NODE_ENV === 'test',
});

// ─── Body parsing with rawBody capture ───────────────────────────────────────
// req.rawBody is needed for Linq HMAC verification.
// Use body-parser's verify option so the raw body is captured without
// consuming the stream before the parser runs.
function captureRawBody(req, res, buf) {
  req.rawBody = buf.toString();
}

app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody })); // needed for Twilio form-encoded payloads

// Apply rate limiters
app.use('/webhook', webhookLimiter);
app.use('/telegram-webhook', webhookLimiter);
app.use('/graph-webhook', strictLimiter);
app.use('/gmail-webhook', strictLimiter);
app.use('/discord-digest', strictLimiter);
app.use('/auth/microsoft', authLimiter);
app.use('/auth/google', authLimiter);

// ─── Health endpoint ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date(),
    providers: [
      isLinqAvailable() && 'linq',
      isTelegramAvailable() && 'telegram',
      'twilio',
    ].filter(Boolean),
  });
});

// ─── Agent registry status ────────────────────────────────────────────────────
// Probes registered agent /health endpoints and returns a unified status view.
// Configure agents by setting PLAYWRIGHT_AGENT_URL (and optionally more) in .env

const REGISTERED_AGENTS = [
  { name: 'playwright-agent', urlEnv: 'PLAYWRIGHT_AGENT_URL' },
];

app.get('/agents/status', async (req, res) => {
  const probes = REGISTERED_AGENTS
    .map(agent => ({ ...agent, url: process.env[agent.urlEnv] }))
    .filter(agent => agent.url);

  const results = await Promise.all(
    probes.map(async agent => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${agent.url}/health`, {
          signal: controller.signal,
        });
        const data = await response.json();
        return { name: agent.name, url: agent.url, online: true, ...data };
      } catch (err) {
        return {
          name: agent.name,
          url: agent.url,
          online: false,
          error: err.name === 'AbortError' ? 'timeout' : err.message,
        };
      } finally {
        clearTimeout(timer);
      }
    })
  );

  res.json({
    agents: results,
    total: results.length,
    online: results.filter(a => a.online).length,
    timestamp: new Date().toISOString(),
  });
});

// ─── Conditional Linq webhook verification middleware ─────────────────────────

function conditionalLinqVerify(req, res, next) {
  if (isLinqAvailable()) {
    return verifyLinqWebhook(req, res, next);
  }
  next();
}

// ─── Webhook endpoint (handles both Linq and Twilio) ─────────────────────────

app.post('/webhook', conditionalLinqVerify, async (req, res) => {
  if (!isLinqAvailable()) {
    // Twilio mode: validate signature before responding
    const webhookUrl =
      process.env.LINQ_WEBHOOK_URL ||
      `${req.protocol}://${req.get('host')}/webhook`;

    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      webhookUrl,
      req.body
    );

    if (!valid && process.env.NODE_ENV !== 'test') {
      return res.sendStatus(403);
    }
  }

  // Respond immediately — process async
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      if (isLinqAvailable()) {
        await handleLinqWebhook(req.body);
      } else {
        await handleTwilioWebhook(req.body);
      }
    } catch (err) {
      console.error('Webhook processing error:', err.message || err);
    }
  });
});

async function handleLinqWebhook(body) {
  if (body.event !== 'message.received') return;

  const data = body.data || {};
  const phoneNumber = data.from;
  const messageBody = data.body?.trim();
  const messageId = data.id;
  const service = data.service;

  if (!messageBody || !phoneNumber) return;

  // Deduplicate on messageId
  if (messageId) {
    if (processedIds.has(messageId)) return;
    processedIds.add(messageId);
  }

  const user = await db.getOrCreateUser(phoneNumber);
  await detectAndUpdateMessagingService(user.id, service || 'iMessage');

  // Check pending deletion confirmation before normal processing
  if (user.deletion_code && user.deletion_code_expires_at > new Date()) {
    const deleted = await confirmDeletion(user.id, messageBody);
    if (deleted) {
      await sendMessage(phoneNumber, "your account and all data have been deleted. take care 👋", null);
    } else {
      await sendMessage(phoneNumber, "that code didn't match — text 'delete my account' again to get a new one", user.id);
    }
    return;
  }

  if (!user.onboarding_complete) {
    await handleOnboardingMessage(user, messageBody);
  } else {
    const reply = await getResponse(user.id, messageBody);
    if (reply) await sendMessage(phoneNumber, reply, user.id);
  }
}

async function handleTwilioWebhook(body) {
  const phoneNumber = body.From;
  const messageBody = body.Body?.trim();

  if (!messageBody || !phoneNumber) return;

  const user = await db.getOrCreateUser(phoneNumber);
  await detectAndUpdateMessagingService(user.id, 'SMS');

  // Check pending deletion confirmation before normal processing
  if (user.deletion_code && user.deletion_code_expires_at > new Date()) {
    const deleted = await confirmDeletion(user.id, messageBody);
    if (deleted) {
      await sendMessage(phoneNumber, "your account and all data have been deleted. take care 👋", null);
    } else {
      await sendMessage(phoneNumber, "that code didn't match — text 'delete my account' again to get a new one", user.id);
    }
    return;
  }

  if (!user.onboarding_complete) {
    await handleOnboardingMessage(user, messageBody);
  } else {
    const reply = await getResponse(user.id, messageBody);
    if (reply) await sendMessage(phoneNumber, reply, user.id);
  }
}

// ─── Microsoft Graph webhook ─────────────────────────────────────────────────
// GET handles the initial validation challenge from Graph (sends back validationToken)
// POST handles real-time notifications for new emails

app.get('/graph-webhook', graphWebhookHandler);
app.post('/graph-webhook', graphWebhookHandler);

// ─── Gmail Pub/Sub webhook ────────────────────────────────────────────────────
// Google sends a POST with a base64-encoded Pub/Sub message containing the
// Gmail address and new historyId. Acknowledge immediately with 204, then
// process async so Google doesn't retry due to slow response.

app.post('/gmail-webhook', (req, res) => {
  res.status(204).send();
  setImmediate(() => {
    handleGmailNotification(req.body)
      .catch(e => console.error('Gmail webhook processing error:', e.message || e));
  });
});

// ─── Discord digest ───────────────────────────────────────────────────────────

app.post('/discord-digest', handleDiscordDigest);

// ─── Telegram webhook ─────────────────────────────────────────────────────────
// Telegram POSTs a JSON Update object to this URL.
// Verified via X-Telegram-Bot-Api-Secret-Token if TELEGRAM_WEBHOOK_SECRET is set.

app.post('/telegram-webhook', verifyTelegramWebhook, (req, res) => {
  res.sendStatus(200); // acknowledge immediately
  setImmediate(async () => {
    try {
      await handleTelegramUpdate(req.body);
    } catch (err) {
      console.error('Telegram webhook error:', err.message || err);
    }
  });
});

async function handleTelegramUpdate(update) {
  const message = update.message || update.edited_message;
  if (!message || !message.text) return;

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const firstName = message.from?.first_name;

  if (!text) return;

  const user = await db.getOrCreateUserByTelegram(chatId, firstName);
  if (!user) return;

  // /start — treat as a fresh greeting; re-run step 0 if not yet onboarded
  if (text === '/start') {
    if (user.onboarding_complete) {
      await sendMessage(null, "you're already all set! text me anything — i'm here", user.id);
    } else {
      // Reset to step 0 so they get the intro messages
      await db.updateUser(user.id, { onboarding_step: 0 });
      const freshUser = { ...user, onboarding_step: 0 };
      await handleOnboardingMessage(freshUser, text);
    }
    return;
  }

  // Deletion confirmation flow
  if (user.deletion_code && new Date(user.deletion_code_expires_at) > new Date()) {
    const deleted = await confirmDeletion(user.id, text);
    if (deleted) {
      await sendMessage(null, "your account and all data have been deleted. take care 👋", null);
      // Send directly since userId is now gone
      const { telegramSendMessage } = require('./sms');
      await telegramSendMessage(chatId, "your account and all data have been deleted. take care 👋")
        .catch(() => {});
    } else {
      await sendMessage(null, "that code didn't match — text 'delete my account' again to get a new one", user.id);
    }
    return;
  }

  if (!user.onboarding_complete) {
    await handleOnboardingMessage(user, text);
  } else {
    const reply = await getResponse(user.id, text);
    if (reply) await sendMessage(null, reply, user.id);
  }
}

// ─── Microsoft OAuth callback ─────────────────────────────────────────────────

app.get('/auth/microsoft', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or state');

  try {
    const { ConfidentialClientApplication } = require('@azure/msal-node');
    const cca = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.MICROSOFT_CLIENT_ID,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}`,
      },
    });

    const result = await cca.acquireTokenByCode({
      code,
      scopes: ['Mail.Read', 'Calendars.Read', 'offline_access', 'User.Read'],
      redirectUri: process.env.MICROSOFT_REDIRECT_URI,
    });

    await db.updateUser(userId, { microsoft_refresh_token: result.refreshToken });

    const user = await db.getUserById(userId);
    if (user) {
      await sendMessage(user.phone_number, 'school email connected ✓', userId);
    }

    res.send('<html><body><h2>Connected! You can close this tab.</h2></body></html>');
  } catch (err) {
    console.error('Microsoft OAuth error:', err.message || err);
    res.status(500).send('Authentication failed — please try the link again');
  }
});

// ─── Google OAuth callback ─────────────────────────────────────────────────────

app.get('/auth/google', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or state');

  try {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );

    const { tokens } = await oauth2Client.getToken(code);
    await db.updateUser(userId, { google_refresh_token: tokens.refresh_token });

    const user = await db.getUserById(userId);
    if (user) {
      await sendMessage(user.phone_number, 'personal email connected ✓', userId);
    }

    res.send('<html><body><h2>Connected! You can close this tab.</h2></body></html>');
  } catch (err) {
    console.error('Google OAuth error:', err.message || err);
    res.status(500).send('Authentication failed — please try the link again');
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

function validateOAuthConfig() {
  const required = [
    ['MICROSOFT_CLIENT_ID',     'Azure Portal → App registrations → Application (client) ID'],
    ['MICROSOFT_CLIENT_SECRET', 'Azure Portal → App registrations → Certificates & secrets'],
    ['MICROSOFT_REDIRECT_URI',  'e.g. https://your-app.railway.app/auth/microsoft'],
    ['GOOGLE_CLIENT_ID',        'Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 client ID'],
    ['GOOGLE_CLIENT_SECRET',    'Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 client secret'],
    ['GOOGLE_REDIRECT_URI',     'e.g. https://your-app.railway.app/auth/google'],
  ];
  const missing = required.filter(([key]) => !process.env[key]);
  if (missing.length > 0) {
    console.warn('⚠️  OAuth credentials not configured — Microsoft/Google sign-in will be unavailable:');
    for (const [key, hint] of missing) {
      console.warn(`   ${key}  →  ${hint}`);
    }
  }
}

async function startup() {
  validateOAuthConfig();
  await db.setup();
  console.log('database ready');

  await initQdrant();
  console.log('memory ready');

  await downloadAndParseGTFS().catch(e =>
    console.error('GTFS load error (non-fatal):', e.message || e)
  );
  console.log('bus routes loaded');

  await renewWebhookSubscriptions().catch(e =>
    console.error('Webhook renewal error (non-fatal):', e.message || e)
  );
  console.log('webhooks renewed');

  await renewGmailWatches().catch(e =>
    console.error('Gmail watch renewal error (non-fatal):', e.message || e)
  );
  console.log('gmail watches renewed');

  if (isLinqAvailable()) {
    await registerLinqWebhook(process.env.LINQ_WEBHOOK_URL)
      .catch(e => console.error('Linq webhook registration failed:', e.message || e));
  }

  if (isTelegramAvailable()) {
    const tgWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL ||
      `${process.env.PUBLIC_URL || ''}/telegram-webhook`;
    await registerTelegramWebhook(tgWebhookUrl)
      .catch(e => console.error('Telegram webhook registration failed:', e.message || e));
  }

  await scheduleAllJobs();
  console.log('scheduler running');

  app.listen(PORT, () => {
    const providers = [
      isLinqAvailable() && 'linq',
      isTelegramAvailable() && 'telegram',
      'twilio',
    ].filter(Boolean).join(', ');
    console.log(`agent running on port ${PORT} (providers: ${providers})`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await db.close();
  process.exit(0);
});

// Only start when run directly — not when required by tests
if (require.main === module) {
  startup().catch(err => {
    console.error('startup failed:', err);
    process.exit(1);
  });
}

module.exports = app;
