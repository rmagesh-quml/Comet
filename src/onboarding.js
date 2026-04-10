'use strict';

const db = require('./db');
const { classify } = require('./utils/claude');
const { sendMessage } = require('./sms');
const { storeClassSchedule } = require('./integrations/schedule');
const { storeMemory } = require('./memory/store');
const { getNearestStops } = require('./integrations/bt_static');
const { parseBriefTime } = require('./briefTime');

// ─── VT dorms with approximate coordinates ────────────────────────────────────

const VT_DORMS = [
  { keywords: ['ambler johnston', 'ambler'],     lat: 37.2232, lng: -80.4250 },
  { keywords: ['peddrew-yates', 'peddrew yates', 'peddrew'],
                                                  lat: 37.2209, lng: -80.4264 },
  { keywords: ['harper'],                         lat: 37.2196, lng: -80.4271 },
  { keywords: ['pritchard'],                      lat: 37.2196, lng: -80.4259 },
  { keywords: ['east eggleston', 'eggleston'],    lat: 37.2214, lng: -80.4228 },
  { keywords: ['west aj'],                        lat: 37.2229, lng: -80.4255 },
  { keywords: ['cochrane'],                       lat: 37.2185, lng: -80.4273 },
  { keywords: ['thomas'],                         lat: 37.2192, lng: -80.4278 },
  { keywords: ['slusher'],                        lat: 37.2222, lng: -80.4293 },
  { keywords: ['new residence east', 'nre'],      lat: 37.2175, lng: -80.4242 },
  { keywords: ['new residence west', 'nrw'],      lat: 37.2173, lng: -80.4248 },
  { keywords: ['hoge'],                           lat: 37.2227, lng: -80.4269 },
  { keywords: ['vawter'],                         lat: 37.2226, lng: -80.4261 },
  { keywords: ['payne'],                          lat: 37.2224, lng: -80.4257 },
  { keywords: ['miles'],                          lat: 37.2196, lng: -80.4237 },
  { keywords: ['barringer'],                      lat: 37.2190, lng: -80.4229 },
  { keywords: ['main campbell'],                  lat: 37.2179, lng: -80.4219 },
  { keywords: ['east campbell'],                  lat: 37.2178, lng: -80.4213 },
  { keywords: ['off-campus', 'off campus', 'apartment', 'house'],
                                                  lat: 37.2284, lng: -80.4234 },
];

const DRILLFIELD_DEFAULT = { lat: 37.2284, lng: -80.4234 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendMultiple(phone, messages, userId) {
  for (const msg of messages) {
    await sendMessage(phone, msg, userId);
  }
}

function extractCanvasUrl(message) {
  const trimmed = message.trim();
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  const domain = withoutProtocol.split(/[/\s]/)[0].toLowerCase();
  if (!domain.includes('.') || domain.length < 4) return null;
  return `https://${domain}`;
}

function matchDorm(message) {
  const lower = message.toLowerCase();
  for (const dorm of VT_DORMS) {
    if (dorm.keywords.some(k => lower.includes(k))) {
      return { lat: dorm.lat, lng: dorm.lng };
    }
  }
  return null;
}

function getMicrosoftOAuthUrl(userId) {
  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  const clientId = process.env.MICROSOFT_CLIENT_ID || '';
  const redirectUri = encodeURIComponent(process.env.MICROSOFT_REDIRECT_URI || '');
  const scopes = encodeURIComponent('Mail.Read Calendars.Read offline_access User.Read');
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${scopes}&state=${userId}`;
}

function getGoogleOAuthUrl(userId) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const redirectUri = encodeURIComponent(process.env.GOOGLE_REDIRECT_URI || '');
  const scopes = encodeURIComponent(
    'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly'
  );
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${scopes}&access_type=offline&state=${userId}`;
}

async function validateCanvasToken(canvasBaseUrl, token) {
  try {
    const response = await fetch(`${canvasBaseUrl}/api/v1/users/self`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ─── Step handlers ────────────────────────────────────────────────────────────

async function handleStep0(userId, phone) {
  const agentName = process.env.AGENT_NAME || 'Comet';
  await sendMultiple(phone, [
    `${agentName} here 👋`,
    "i'm a proactive AI that texts you before you even ask — i connect to your classes, email, and calendar to stay one step ahead",
    "what's your name?",
  ], userId);
  await db.updateUser(userId, { onboarding_step: 1 });
}

async function handleStep1(userId, phone, message) {
  let name;
  try {
    const raw = await classify(
      `Extract the person's name from this message. Return JSON: {"name": string}\nMessage: ${message}`,
      50
    );
    const parsed = JSON.parse(raw.trim());
    name = parsed.name || message.trim().split(/\s+/)[0];
  } catch {
    name = message.trim().split(/\s+/)[0];
  }

  // Normalize capitalization (first letter uppercase, rest preserved)
  name = name.charAt(0).toUpperCase() + name.slice(1);

  await db.updateUser(userId, { name, onboarding_step: 2 });
  await sendMultiple(phone, [
    `nice to meet you ${name}!`,
    "let's connect Canvas first",
    "what's your Canvas URL? (like canvas.vt.edu)",
  ], userId);
}

async function handleStep2(userId, phone, message) {
  const url = extractCanvasUrl(message);
  if (!url) {
    await sendMessage(phone, "hmm, that doesn't look right — try something like canvas.vt.edu", userId);
    return;
  }

  await db.updateUser(userId, { canvas_base_url: url, onboarding_step: 3 });
  await sendMultiple(phone, [
    `got it — go to ${url}/profile/settings`,
    "scroll to Approved Integrations, click New Access Token",
    "name it anything, copy it, send it to me",
  ], userId);
}

async function handleStep3(userId, phone, message, canvasBaseUrl) {
  const token = message.trim();
  const valid = await validateCanvasToken(canvasBaseUrl, token);

  if (!valid) {
    await sendMessage(phone, "hmm that didn't work — try copying the token again?", userId);
    return;
  }

  await db.updateUser(userId, { canvas_token: token, onboarding_step: 4 });
  await sendMultiple(phone, [
    "Canvas connected ✓",
    "what's your class schedule?",
    "like: MWF 10-11am Algorithms in McBryde, TTh 2-3:30pm Networks in Torg 1100",
  ], userId);
}

async function handleStep4(userId, phone, message) {
  await storeClassSchedule(userId, message);
  await db.updateUser(userId, { onboarding_step: 5 });
  await sendMultiple(phone, [
    "got your schedule — i'll never text you during class 😅",
    "want to connect your email and calendar? reply yes for setup links or skip",
  ], userId);
}

async function handleStep5(userId, phone, message) {
  const lower = message.toLowerCase().trim();
  const wantsEmail = ['yes', 'y', 'sure', 'yeah'].some(w =>
    lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ',')
  );

  if (wantsEmail) {
    const microsoftUrl = getMicrosoftOAuthUrl(userId);
    const googleUrl = getGoogleOAuthUrl(userId);
    await db.updateUser(userId, { onboarding_step: 6 });
    await sendMultiple(phone, [
      "two links — connect either or both:",
      `school email (Outlook): ${microsoftUrl}`,
      `personal email (Gmail): ${googleUrl}`,
      "reply done when connected or skip",
    ], userId);
  } else {
    // Skip email — jump straight to dorm question
    await db.updateUser(userId, { onboarding_step: 7 });
    await sendMessage(phone, "what's your dorm or apartment? i'll track buses from there", userId);
  }
}

async function handleStep6(userId, phone, message) {
  const lower = message.toLowerCase().trim();
  const isDone = ['done', 'connected', 'both', 'yes', 'ok', 'k', 'great', 'good'].some(w =>
    lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ',')
  );

  if (isDone) {
    await sendMessage(phone, "email connected ✓", userId);
  }

  await db.updateUser(userId, { onboarding_step: 7 });
  await sendMessage(phone, "what's your dorm or apartment? i'll track buses from there", userId);
}

async function handleStep7(userId, phone, message, user) {
  const lower = message.toLowerCase().trim();
  const isSkip = ['skip', 'no', 'later', 'n', 'nah', 'nope', 'idk', 'pass'].some(w =>
    lower === w || lower.startsWith(w + ' ')
  );

  if (!isSkip) {
    const coords = matchDorm(message) || DRILLFIELD_DEFAULT;

    try {
      await storeMemory(userId, `lives at or near ${message.trim()}`, {
        type: 'preference',
        importance: 7,
        source: 'onboarding',
      });
    } catch { /* fail silently if Qdrant unavailable */ }

    await db.updateUser(userId, { campus_lat: coords.lat, campus_lng: coords.lng });

    try {
      const nearest = await getNearestStops(coords.lat, coords.lng, 1);
      if (nearest.length > 0) {
        await db.updateUser(userId, { nearest_bus_stop_id: nearest[0].stopId });
      }
    } catch { /* fail silently if bus stops not seeded */ }

    await sendMessage(phone, "got it — tracking buses from your stop ✓", userId);
  }

  await db.updateUser(userId, { onboarding_step: 8 });
  await sendMessage(phone, "one last thing — what time do you want your morning brief? (like 8am, 8:30am, or just skip)", userId);
}

async function handleStep8(userId, phone, message) {
  const lower = message.toLowerCase().trim();
  const isSkip = ['skip', 'no', 'later', 'default', 'idc', 'idk', '9', '9am'].some(w =>
    lower === w || lower.startsWith(w + ' ')
  );

  if (!isSkip) {
    const parsed = parseBriefTime(message);
    if (parsed) {
      const { hour, minute } = parsed;
      const clampedHour = Math.min(11, Math.max(6, hour));
      await db.updateBriefPreference(userId, clampedHour, minute);
    }
  }

  const user = await db.getUserById(userId);
  await completeOnboarding(userId, phone, user?.name);
}

async function completeOnboarding(userId, phone, name) {
  await db.updateUser(userId, { onboarding_complete: true, onboarding_step: 9 });

  // Use user's preferred brief time — they just set it in step 8
  const user = await db.getUserById(userId);
  const briefHour = user?.preferred_brief_hour ?? 8;
  const briefMinute = user?.preferred_brief_minute ?? 0;
  const tomorrowBrief = new Date();
  tomorrowBrief.setDate(tomorrowBrief.getDate() + 1);
  tomorrowBrief.setHours(briefHour, briefMinute, 0, 0);
  await db.scheduleMessage(userId, tomorrowBrief, 'morning brief', {}, 'morning_brief');

  const timeDisplay = briefMinute > 0
    ? `${briefHour % 12 || 12}:${String(briefMinute).padStart(2, '0')}${briefHour < 12 ? 'am' : 'pm'}`
    : `${briefHour % 12 || 12}${briefHour < 12 ? 'am' : 'pm'}`;

  await sendMultiple(phone, [
    `you're all set ${name || ''}!`,
    `i'll text you tomorrow at ${timeDisplay} with your day — classes, assignments, anything that needs attention`,
    "text me anytime — i'm always here",
  ], userId);
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function handleOnboardingMessage(user, message) {
  const { id: userId, phone_number: phone, onboarding_step: step } = user;

  switch (step) {
    case 0:  return handleStep0(userId, phone);
    case 1:  return handleStep1(userId, phone, message);
    case 2:  return handleStep2(userId, phone, message);
    case 3:  return handleStep3(userId, phone, message, user.canvas_base_url);
    case 4:  return handleStep4(userId, phone, message);
    case 5:  return handleStep5(userId, phone, message);
    case 6:  return handleStep6(userId, phone, message);
    case 7:  return handleStep7(userId, phone, message, user);
    case 8:  return handleStep8(userId, phone, message);
    case 9:  return sendMessage(phone, "you're already all set! text me anything — i'm here", userId);
    default: return handleStep0(userId, phone);
  }
}

module.exports = {
  handleOnboardingMessage,
  // Exported for testing
  extractCanvasUrl,
  matchDorm,
  getMicrosoftOAuthUrl,
  getGoogleOAuthUrl,
};
