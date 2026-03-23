'use strict';

const { google } = require('googleapis');
const db = require('../db');
const cache = require('../utils/cache');
const sms = require('../sms');
const outlook = require('./outlook');

// ─── Internship detection ─────────────────────────────────────────────────────

const INTERNSHIP_DOMAINS = [
  'lever.co', 'greenhouse.io', 'workday.com', 'smartrecruiters.com', 'ashbyhq.com',
];

const INTERNSHIP_SUBJECT_KEYWORDS = [
  'offer letter', 'move forward', 'next steps', 'application update',
];

function isInternshipEmail(email) {
  const from = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  if (INTERNSHIP_DOMAINS.some(d => from.includes(d))) return true;
  if (INTERNSHIP_SUBJECT_KEYWORDS.some(k => subject.includes(k))) return true;
  return false;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getGoogleClients(userId) {
  const user = await db.getUserById(userId);
  if (!user || !user.google_refresh_token) return null;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );

  oauth2Client.setCredentials({ refresh_token: user.google_refresh_token });

  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.refresh_token) {
      await db.updateUser(userId, { google_refresh_token: tokens.refresh_token });
    }
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  return { gmail, calendar };
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function getHeader(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function parseEmailAddress(fromHeader) {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : fromHeader.toLowerCase();
}

function parseEmailName(fromHeader) {
  const match = fromHeader.match(/^"?(.+?)"?\s*</);
  return match ? match[1].trim() : fromHeader;
}

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return '';
}

// ─── Unread emails ────────────────────────────────────────────────────────────

async function getUnreadEmails(userId, maxResults = 15) {
  const cacheKey = `gmail:unread:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const clients = await getGoogleClients(userId);
  if (!clients) return [];

  try {
    const listResponse = await clients.gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox',
      maxResults,
    });

    const messages = listResponse.data.messages || [];
    if (messages.length === 0) {
      cache.set(cacheKey, [], 5);
      return [];
    }

    const metadataResults = await Promise.all(
      messages.map(m =>
        clients.gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date'],
        }).then(r => r.data).catch(() => null)
      )
    );

    const emails = metadataResults
      .filter(Boolean)
      .map(msg => {
        const headers = msg.payload?.headers || [];
        const fromHeader = getHeader(headers, 'From');
        const subject = getHeader(headers, 'Subject');
        const date = getHeader(headers, 'Date');
        const from = parseEmailAddress(fromHeader);
        const emailObj = { subject, from };
        return {
          id: msg.id,
          subject,
          from,
          fromName: parseEmailName(fromHeader),
          date: date ? new Date(date).toISOString() : null,
          snippet: msg.snippet || '',
          isImportant: outlook.isEmailImportant(emailObj).important,
          isInternship: isInternshipEmail(emailObj),
        };
      });

    cache.set(cacheKey, emails, 5);
    return emails;
  } catch (err) {
    console.error(`getUnreadEmails (Gmail) error for user ${userId}:`, err.message || err);
    return [];
  }
}

// ─── Email body ───────────────────────────────────────────────────────────────

async function getEmailBody(userId, messageId) {
  const clients = await getGoogleClients(userId);
  if (!clients) return null;

  try {
    const response = await clients.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const text = extractPlainText(response.data.payload);
    return text.slice(0, 800) || null;
  } catch (err) {
    console.error(`getEmailBody (Gmail) error for user ${userId}:`, err.message || err);
    return null;
  }
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

async function getGoogleCalendarEvents(userId, daysAhead = 1) {
  const cacheKey = `google:calendar:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const clients = await getGoogleClients(userId);
  if (!clients) return [];

  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead).toISOString();

  try {
    const response = await clients.calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = (response.data.items || []).map(e => ({
      title: e.summary || '',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      location: e.location || null,
      isOnlineMeeting: !!(e.hangoutLink || e.conferenceData),
      organizer: e.organizer?.displayName || e.organizer?.email || null,
    }));

    cache.set(cacheKey, events, 10);
    return events;
  } catch (err) {
    console.error(`getGoogleCalendarEvents error for user ${userId}:`, err.message || err);
    return [];
  }
}

// ─── Combined email context ───────────────────────────────────────────────────

async function getAllEmailContext(userId) {
  const [outlookResult, gmailResult] = await Promise.allSettled([
    outlook.getUnreadEmails(userId),
    getUnreadEmails(userId),
  ]);

  const rawSchool = outlookResult.status === 'fulfilled' ? outlookResult.value : [];
  const rawPersonal = gmailResult.status === 'fulfilled' ? gmailResult.value : [];

  // Tag Outlook emails with importance/internship flags (Gmail emails already have them)
  const schoolEmails = rawSchool.map(e => ({
    ...e,
    isImportant: outlook.isEmailImportant(e).important,
    isInternship: isInternshipEmail(e),
  }));

  async function attachBodies(emails, fetchBodyFn) {
    const topImportant = emails.filter(e => e.isImportant || e.isInternship).slice(0, 3);
    return Promise.all(topImportant.map(async e => ({
      ...e,
      body: await fetchBodyFn(userId, e.id).catch(() => null),
    })));
  }

  const [school, personal] = await Promise.all([
    attachBodies(schoolEmails, (uid, id) => outlook.getEmailBody(uid, id)),
    attachBodies(rawPersonal, getEmailBody),
  ]);

  return { school, personal };
}

// ─── Venmo ────────────────────────────────────────────────────────────────────

const VENMO_PAID_RE = /^You paid (.+?) \$([0-9,]+(?:\.[0-9]{1,2})?) for (.+)$/i;
const VENMO_RECEIVED_RE = /^(.+?) paid you \$([0-9,]+(?:\.[0-9]{1,2})?) for (.+)$/i;

async function parseVenmoEmails(userId) {
  const clients = await getGoogleClients(userId);
  if (!clients) return null;

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const afterDate = thirtyDaysAgo.toISOString().split('T')[0].replace(/-/g, '/');

  try {
    const listResponse = await clients.gmail.users.messages.list({
      userId: 'me',
      q: `from:venmo@venmo.com after:${afterDate}`,
      maxResults: 100,
    });

    const messages = listResponse.data.messages || [];
    if (messages.length === 0) {
      return { monthlySpend: 0, transactions: [], isLowOnFunds: false };
    }

    const metadataResults = await Promise.all(
      messages.map(m =>
        clients.gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'Date'],
        }).then(r => r.data).catch(() => null)
      )
    );

    const transactions = [];
    for (const msg of metadataResults) {
      if (!msg) continue;
      const headers = msg.payload?.headers || [];
      const subject = getHeader(headers, 'Subject');
      const dateStr = getHeader(headers, 'Date');
      const date = dateStr ? new Date(dateStr) : null;

      const paidMatch = subject.match(VENMO_PAID_RE);
      if (paidMatch) {
        transactions.push({
          direction: 'paid',
          name: paidMatch[1].trim(),
          amount: parseFloat(paidMatch[2].replace(/,/g, '')),
          desc: paidMatch[3].trim(),
          date,
        });
        continue;
      }

      const receivedMatch = subject.match(VENMO_RECEIVED_RE);
      if (receivedMatch) {
        transactions.push({
          direction: 'received',
          name: receivedMatch[1].trim(),
          amount: parseFloat(receivedMatch[2].replace(/,/g, '')),
          desc: receivedMatch[3].trim(),
          date,
        });
      }
      // Subjects matching neither pattern are silently skipped
    }

    const monthlySpend = transactions
      .filter(t => t.direction === 'paid')
      .reduce((sum, t) => sum + t.amount, 0);

    // isLowOnFunds: current calendar-month spend already exceeds 70% of last-30-day baseline
    const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const currentMonthSpend = transactions
      .filter(t => t.direction === 'paid' && t.date && t.date >= currentMonthStart)
      .reduce((sum, t) => sum + t.amount, 0);

    const isLowOnFunds = monthlySpend > 0 && currentMonthSpend > 0.7 * monthlySpend;

    return { monthlySpend, transactions, isLowOnFunds };
  } catch (err) {
    console.error(`parseVenmoEmails error for user ${userId}:`, err.message || err);
    return null;
  }
}

// ─── Gmail webhook setup ──────────────────────────────────────────────────────

async function setupGmailWebhook(userId) {
  const clients = await getGoogleClients(userId);
  if (!clients) return;

  try {
    const response = await clients.gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: process.env.GOOGLE_PUBSUB_TOPIC,
        labelIds: ['INBOX'],
      },
    });

    await db.updateUser(userId, { google_history_id: response.data.historyId });
    console.log(`Gmail webhook set up for user ${userId}, historyId: ${response.data.historyId}`);
  } catch (err) {
    console.error(`setupGmailWebhook error for user ${userId}:`, err.message || err);
  }
}

// ─── Notification processing (called from /gmail-webhook handler) ─────────────

async function handleGmailNotification(body) {
  const messageData = body?.message?.data;
  if (!messageData) return;

  let notification;
  try {
    notification = JSON.parse(Buffer.from(messageData, 'base64').toString('utf-8'));
  } catch {
    console.error('Failed to decode Gmail Pub/Sub payload');
    return;
  }

  const { emailAddress, historyId: newHistoryId } = notification;
  if (!emailAddress || !newHistoryId) return;

  const user = await db.getUserByGoogleEmail(emailAddress);
  if (!user || !user.google_history_id) return;

  const clients = await getGoogleClients(user.id);
  if (!clients) return;

  // Fetch messages added since last known historyId
  let newMessageIds = [];
  try {
    const historyResponse = await clients.gmail.users.history.list({
      userId: 'me',
      startHistoryId: user.google_history_id,
      historyTypes: ['messageAdded'],
    });
    for (const item of (historyResponse.data.history || [])) {
      for (const msg of (item.messagesAdded || [])) {
        newMessageIds.push(msg.message.id);
      }
    }
  } catch (err) {
    console.error(`History list error for user ${user.id}:`, err.message || err);
    return;
  }

  // Persist the new historyId before processing so we don't re-process on retry
  await db.updateUser(user.id, { google_history_id: newHistoryId });

  for (const messageId of newMessageIds) {
    try {
      const msgResponse = await clients.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });
      const headers = msgResponse.data.payload?.headers || [];
      const fromHeader = getHeader(headers, 'From');
      const subject = getHeader(headers, 'Subject');
      const from = parseEmailAddress(fromHeader);
      const emailMeta = { subject, from };

      const isInternship = isInternshipEmail(emailMeta);
      const { important } = outlook.isEmailImportant(emailMeta);

      if (isInternship) {
        await sms.sendMessage(
          user.phone_number,
          `🚨 internship email — ${subject} from ${from}`,
          user.id,
        );
      } else if (important) {
        await sms.sendMessage(
          user.phone_number,
          `📬 new email — ${subject} from ${from}`,
          user.id,
        );
      }
    } catch (err) {
      console.error(`Error processing message ${messageId}:`, err.message || err);
    }
  }
}

// ─── Renewal ──────────────────────────────────────────────────────────────────

async function renewGmailWatches() {
  let users;
  try {
    users = await db.getAllActiveUsers();
  } catch (err) {
    console.error('renewGmailWatches: failed to fetch users:', err.message || err);
    return;
  }

  for (const user of users) {
    if (!user.google_refresh_token) continue;
    try {
      await setupGmailWebhook(user.id);
    } catch (err) {
      console.error(`renewGmailWatches: error for user ${user.id}:`, err.message || err);
    }
  }
}

module.exports = {
  getGoogleClients,
  getUnreadEmails,
  getEmailBody,
  getGoogleCalendarEvents,
  getAllEmailContext,
  parseVenmoEmails,
  setupGmailWebhook,
  renewGmailWatches,
  handleGmailNotification,
  isInternshipEmail,
};
