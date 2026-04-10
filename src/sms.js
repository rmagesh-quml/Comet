'use strict';

const crypto = require('crypto');
const fs = require('fs');
const twilio = require('twilio');
const db = require('./db');
const { checkLimit, incrementCount } = require('./utils/limiter');

// ─── Twilio client (lazy) ────────────────────────────────────────────────────

let twilioClient = null;

function getTwilioClient() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

// ─── Provider detection ──────────────────────────────────────────────────────

function isLinqAvailable() {
  return !!(process.env.LINQ_API_TOKEN && process.env.LINQ_API_TOKEN.trim() !== '');
}

async function isIMessageUser(userId) {
  // Default true — college students are ~95% iPhone
  // Can be refined per-user via user preferences as data is collected
  return true;
}

// ─── Linq implementation ─────────────────────────────────────────────────────

const LINQ_BASE = 'https://api.linqapp.com/api/partner/v3';

function linqHeaders() {
  return {
    Authorization: `Bearer ${process.env.LINQ_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function linqSendMessage(toNumber, text) {
  const res = await fetch(`${LINQ_BASE}/messages`, {
    method: 'POST',
    headers: linqHeaders(),
    body: JSON.stringify({
      to: toNumber,
      from: process.env.LINQ_PHONE_NUMBER,
      body: text,
      preferred_service: 'iMessage',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linq error ${res.status}: ${body}`);
  }
  return res.json();
}

async function linqSendTypingIndicator(toNumber) {
  try {
    await fetch(`${LINQ_BASE}/typing-indicators`, {
      method: 'POST',
      headers: linqHeaders(),
      body: JSON.stringify({
        to: toNumber,
        from: process.env.LINQ_PHONE_NUMBER,
      }),
    });
  } catch (_) {
    // fire and forget — swallow all errors
  }
}

async function linqSendReaction(toNumber, messageId, emoji) {
  try {
    await fetch(`${LINQ_BASE}/reactions`, {
      method: 'POST',
      headers: linqHeaders(),
      body: JSON.stringify({
        to: toNumber,
        from: process.env.LINQ_PHONE_NUMBER,
        message_id: messageId,
        reaction: emoji,
      }),
    });
  } catch (_) {
    // best-effort — swallow errors
  }
}

// ─── Linq webhook management ──────────────────────────────────────────────────

const SIGNING_SECRET_FILE = '.linq-signing-secret';

async function registerLinqWebhook(webhookUrl) {
  if (fs.existsSync(SIGNING_SECRET_FILE)) {
    console.log('Linq webhook already registered, reading secret from file');
    return getLinqSigningSecret();
  }

  const res = await fetch(`${LINQ_BASE}/webhook-subscriptions`, {
    method: 'POST',
    headers: linqHeaders(),
    body: JSON.stringify({
      target_url: webhookUrl,
      subscribed_events: [
        'message.received',
        'message.delivered',
        'message.read',
        'message.failed',
        'reaction.added',
        'reaction.removed',
        'chat.typing_indicator.started',
        'chat.typing_indicator.stopped',
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linq webhook registration failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  const signingSecret = data.subscription.signing_secret;
  fs.writeFileSync(SIGNING_SECRET_FILE, signingSecret, 'utf8');
  console.log('Linq webhook registered, signing secret saved');
  return signingSecret;
}

function getLinqSigningSecret() {
  try {
    return fs.readFileSync(SIGNING_SECRET_FILE, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function verifyLinqWebhook(req, res, next) {
  const timestamp = req.headers['x-webhook-timestamp'];
  const signature = req.headers['x-webhook-signature'];

  if (!timestamp || !signature) {
    return res.status(401).send('Missing signature headers');
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return res.status(401).send('request too old');
  }

  const secret = getLinqSigningSecret();
  if (!secret) {
    return res.status(401).send('No signing secret configured');
  }

  const signedPayload = `${timestamp}.${req.rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  let valid = false;
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (_) {
    valid = false;
  }

  if (!valid) {
    return res.status(401).send('Invalid signature');
  }

  next();
}

// ─── Telegram implementation ─────────────────────────────────────────────────

const TELEGRAM_API = 'https://api.telegram.org';

function isTelegramAvailable() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim());
}

function telegramApiUrl(method) {
  return `${TELEGRAM_API}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

// Telegram has a 4096-char message limit. Split at the last newline before the limit.
function splitForTelegram(text, limit = 4096) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const lastNewline = slice.lastIndexOf('\n');
    const cutAt = lastNewline > limit * 0.5 ? lastNewline : limit;
    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function telegramSendMessage(chatId, text) {
  const chunks = splitForTelegram(text);
  for (const chunk of chunks) {
    const res = await fetch(telegramApiUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        // parse_mode omitted intentionally — plain text is safest default.
        // Markdown in user-facing messages can break on unescaped characters.
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram sendMessage error ${res.status}: ${body}`);
    }
  }
}

async function telegramSendTypingIndicator(chatId) {
  try {
    await fetch(telegramApiUrl('sendChatAction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch (_) {
    // fire and forget
  }
}

// Register (or re-register) the bot webhook with Telegram.
// Called once at startup when TELEGRAM_BOT_TOKEN is configured.
async function registerTelegramWebhook(webhookUrl) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const body = { url: webhookUrl, allowed_updates: ['message'] };
  if (secret) body.secret_token = secret;

  const res = await fetch(telegramApiUrl('setWebhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram webhook registration failed: ${data.description}`);
  console.log('Telegram webhook registered:', webhookUrl);
}

// Verify the X-Telegram-Bot-Api-Secret-Token header (optional but recommended).
function verifyTelegramWebhook(req, res, next) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return next(); // no secret configured → skip verification

  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!header || header !== secret) {
    return res.status(401).send('Invalid Telegram webhook secret');
  }
  next();
}

// ─── Twilio implementation ────────────────────────────────────────────────────

async function twilioSendMessage(toNumber, text) {
  const client = getTwilioClient();
  if (!client) throw new Error('Twilio not configured');
  return client.messages.create({
    body: text,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: toNumber,
  });
}

async function twilioSendMultiple(toNumber, texts) {
  const results = [];
  for (let i = 0; i < texts.length; i++) {
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    results.push(await twilioSendMessage(toNumber, texts[i]));
  }
  return results;
}

// ─── Unified public API ───────────────────────────────────────────────────────

async function sendMessage(toNumber, text, userId) {
  const userOk = await checkLimit(userId);
  if (!userOk) {
    console.log(`Per-user limit reached for userId=${userId}, skipping`);
    return { success: false };
  }

  const globalOk = await db.checkAndIncrementGlobalLimit();
  if (!globalOk) {
    console.log(`Global daily limit reached, skipping message to userId=${userId}`);
    return { success: false };
  }

  try {
    // ── Telegram routing ─────────────────────────────────────────────────────
    // Telegram-only users have no phone number. When toNumber is falsy and
    // we have a userId, look up their telegram_chat_id and route there.
    if (!toNumber && userId && isTelegramAvailable()) {
      const user = await db.getUserById(userId);
      if (user?.telegram_chat_id) {
        await telegramSendMessage(user.telegram_chat_id, text);
        await db.logSentMessage(userId, 'outbound', text, 'sent');
        await incrementCount(userId);
        return { success: true, provider: 'telegram' };
      }
      console.error(`sendMessage: no toNumber and no telegram_chat_id for userId=${userId}`);
      return { success: false };
    }

    // ── SMS routing: Linq → Twilio ────────────────────────────────────────────
    let messageId = null;
    let provider = 'twilio';

    if (isLinqAvailable() && await isIMessageUser(userId)) {
      try {
        const result = await linqSendMessage(toNumber, text);
        messageId = result?.id || null;
        provider = 'linq';
      } catch (linqErr) {
        console.error('Linq failed, falling back to Twilio:', linqErr.message || linqErr);
        try {
          const result = await twilioSendMessage(toNumber, text);
          messageId = result?.sid || null;
          provider = 'twilio';
        } catch (twilioErr) {
          console.error('Twilio fallback also failed:', twilioErr.message || twilioErr);
          return { success: false };
        }
      }
    } else {
      try {
        const result = await twilioSendMessage(toNumber, text);
        messageId = result?.sid || null;
        provider = 'twilio';
      } catch (err) {
        console.error('Twilio send failed:', err.message || err);
        return { success: false };
      }
    }

    await db.logSentMessage(userId, 'outbound', text, 'sent');
    await incrementCount(userId);
    return { success: true, messageId, provider };
  } catch (err) {
    console.error('sendMessage unexpected error:', err.message || err);
    return { success: false };
  }
}

async function sendMultiple(toNumber, texts, userId, delayMs = 1500) {
  const results = [];

  // Telegram: send all messages, pause briefly between to preserve order
  if (!toNumber && userId && isTelegramAvailable()) {
    const user = await db.getUserById(userId);
    if (user?.telegram_chat_id) {
      for (let i = 0; i < texts.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 400));
        results.push(await sendMessage(null, texts[i], userId));
      }
      return results;
    }
  }

  // SMS: Linq → Twilio
  if (isLinqAvailable() && await isIMessageUser(userId)) {
    for (let i = 0; i < texts.length; i++) {
      if (i > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        const result = await linqSendMessage(toNumber, texts[i]);
        results.push({ success: true, messageId: result?.id || null });
      } catch (linqErr) {
        console.error('Linq failed for message, falling back:', linqErr.message || linqErr);
        try {
          const result = await twilioSendMessage(toNumber, texts[i]);
          results.push({ success: true, messageId: result?.sid || null });
        } catch (twilioErr) {
          console.error('Twilio fallback failed:', twilioErr.message || twilioErr);
          results.push({ success: false });
        }
      }
    }
  } else {
    return twilioSendMultiple(toNumber, texts);
  }

  return results;
}

async function sendTypingIndicator(toNumber, userId) {
  if (!toNumber && userId && isTelegramAvailable()) {
    // Telegram-only user — look up chat_id and send typing action
    db.getUserById(userId).then(user => {
      if (user?.telegram_chat_id) telegramSendTypingIndicator(user.telegram_chat_id);
    }).catch(() => {});
    return;
  }
  if (isLinqAvailable() && await isIMessageUser(userId)) {
    linqSendTypingIndicator(toNumber); // fire and forget
  }
  // else no-op
}

async function sendReaction(toNumber, messageId, emoji, userId) {
  if (isLinqAvailable() && await isIMessageUser(userId)) {
    linqSendReaction(toNumber, messageId, emoji); // fire and forget
  }
  // else no-op silently
}

async function detectAndUpdateMessagingService(userId, service) {
  // No-op: messaging_service is not stored in the current schema.
  // Linq availability and iMessage defaults handle routing automatically.
}

module.exports = {
  // Provider detection
  isLinqAvailable,
  isIMessageUser,
  isTelegramAvailable,
  // Linq internals (exported for testing)
  linqSendMessage,
  linqSendTypingIndicator,
  linqSendReaction,
  registerLinqWebhook,
  getLinqSigningSecret,
  verifyLinqWebhook,
  // Twilio internals (exported for testing)
  twilioSendMessage,
  twilioSendMultiple,
  getTwilioClient,
  // Telegram internals
  telegramSendMessage,
  telegramSendTypingIndicator,
  registerTelegramWebhook,
  verifyTelegramWebhook,
  // Unified public API
  sendMessage,
  sendMultiple,
  sendTypingIndicator,
  sendReaction,
  detectAndUpdateMessagingService,
};
