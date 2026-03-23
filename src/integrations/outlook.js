'use strict';

const { ConfidentialClientApplication } = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
const db = require('../db');
const cache = require('../utils/cache');
const sms = require('../sms');

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getGraphClient(userId) {
  const user = await db.getUserById(userId);
  if (!user || !user.microsoft_refresh_token) return null;

  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || 'common'}`,
    },
  });

  try {
    const result = await cca.acquireTokenByRefreshToken({
      refreshToken: user.microsoft_refresh_token,
      scopes: ['Mail.Read', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite'],
    });

    if (result.refreshToken && result.refreshToken !== user.microsoft_refresh_token) {
      await db.updateUser(userId, { microsoft_refresh_token: result.refreshToken });
    }

    return Client.initWithMiddleware({
      authProvider: {
        getAccessToken: async () => result.accessToken,
      },
    });
  } catch (err) {
    console.error(`Graph client error for user ${userId}:`, err.message || err);
    return null;
  }
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

function getRelativeDayLabel(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() === today.getTime()) return 'today';
  if (d.getTime() === tomorrow.getTime()) return 'tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

function mapEvent(e) {
  return {
    title: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || null,
    isOnlineMeeting: e.isOnlineMeeting || false,
    organizer: e.organizer?.emailAddress?.name || null,
  };
}

async function getTodaysEvents(userId) {
  const cacheKey = `outlook:events:today:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const client = await getGraphClient(userId);
  if (!client) return [];

  const now = new Date();
  const startDateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endDateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  try {
    const response = await client
      .api('/me/calendarView')
      .query({ startDateTime, endDateTime })
      .select('subject,start,end,location,isOnlineMeeting,organizer')
      .get();

    const events = (response.value || [])
      .map(mapEvent)
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    cache.set(cacheKey, events, 10);
    return events;
  } catch (err) {
    console.error(`getTodaysEvents error for user ${userId}:`, err.message || err);
    return [];
  }
}

async function getUpcomingEvents(userId, daysAhead = 3) {
  const cacheKey = `outlook:events:upcoming:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const client = await getGraphClient(userId);
  if (!client) return [];

  const now = new Date();
  const startDateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const endDateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysAhead).toISOString();

  try {
    const response = await client
      .api('/me/calendarView')
      .query({ startDateTime, endDateTime })
      .select('subject,start,end,location,isOnlineMeeting,organizer')
      .get();

    const events = (response.value || [])
      .map(e => ({ ...mapEvent(e), day: getRelativeDayLabel(e.start?.dateTime) }))
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    cache.set(cacheKey, events, 10);
    return events;
  } catch (err) {
    console.error(`getUpcomingEvents error for user ${userId}:`, err.message || err);
    return [];
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────

const IMPORTANT_SUBJECT_KEYWORDS = [
  'grade', 'exam', 'midterm', 'final', 'deadline',
  'urgent', 'financial aid', 'registration',
  'offer', 'interview', 'accepted', 'rejected',
  'office hours', 'action required', 'incomplete',
  'withdrawal', 'scholarship', 'tuition',
];

function isEmailImportant(email) {
  const from = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();

  if (from.includes('.edu')) return { important: true, reason: 'from .edu address' };
  if (from.includes('.gov')) return { important: true, reason: 'from .gov address' };

  for (const keyword of IMPORTANT_SUBJECT_KEYWORDS) {
    if (subject.includes(keyword)) {
      return { important: true, reason: `subject contains "${keyword}"` };
    }
  }

  return { important: false, reason: '' };
}

async function getUnreadEmails(userId, maxResults = 15) {
  const cacheKey = `outlook:unread:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const client = await getGraphClient(userId);
  if (!client) return [];

  try {
    const response = await client
      .api('/me/mailFolders/inbox/messages')
      .filter('isRead eq false')
      .select('subject,from,receivedDateTime,bodyPreview,importance')
      .top(maxResults)
      .get();

    const emails = (response.value || []).map(e => ({
      id: e.id,
      subject: e.subject || '',
      from: e.from?.emailAddress?.address || '',
      fromName: e.from?.emailAddress?.name || '',
      receivedDateTime: e.receivedDateTime,
      bodyPreview: e.bodyPreview || '',
      importance: e.importance,
    }));

    cache.set(cacheKey, emails, 10);
    return emails;
  } catch (err) {
    console.error(`getUnreadEmails error for user ${userId}:`, err.message || err);
    return [];
  }
}

async function getEmailBody(userId, messageId) {
  const client = await getGraphClient(userId);
  if (!client) return null;

  try {
    const message = await client
      .api(`/me/messages/${messageId}`)
      .select('id,subject,from,receivedDateTime,bodyPreview,body,isRead,importance')
      .get();

    // Use bodyPreview as baseline; extract plain text from body if available
    let text = message.bodyPreview || '';
    if (message.body) {
      if (message.body.contentType === 'text') {
        text = message.body.content || text;
      } else {
        text = (message.body.content || '').replace(/<[^>]*>/g, '') || text;
      }
    }

    return text.slice(0, 800) || null;
  } catch (err) {
    console.error(`getEmailBody error for user ${userId}:`, err.message || err);
    return null;
  }
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

async function setupEmailWebhook(userId) {
  const client = await getGraphClient(userId);
  if (!client) return null;

  // Max expiry for mail messages is 4230 minutes (~3 days)
  const expirationDateTime = new Date(Date.now() + 4230 * 60 * 1000).toISOString();
  const notificationUrl = `${process.env.WEBHOOK_BASE_URL}/graph-webhook`;

  try {
    const subscription = await client.api('/subscriptions').post({
      changeType: 'created',
      notificationUrl,
      resource: "me/mailFolders('Inbox')/messages",
      expirationDateTime,
      clientState: String(userId),
    });

    await db.updateUser(userId, {
      microsoft_subscription_id: subscription.id,
      microsoft_subscription_expires: subscription.expirationDateTime,
    });

    console.log(`Email webhook set up for user ${userId}: ${subscription.id}`);
    return subscription.id;
  } catch (err) {
    console.error(`setupEmailWebhook error for user ${userId}:`, err.message || err);
    return null;
  }
}

async function renewWebhookSubscriptions() {
  // Renew subscriptions expiring within 24 hours
  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const result = await db.query(
    `SELECT * FROM users
     WHERE microsoft_subscription_id IS NOT NULL
     AND (microsoft_subscription_expires IS NULL OR microsoft_subscription_expires < $1)`,
    [cutoff.toISOString()]
  );

  for (const user of result.rows) {
    const client = await getGraphClient(user.id);
    if (!client) {
      console.error(`Could not get Graph client for user ${user.id} during renewal`);
      continue;
    }

    const newExpiry = new Date(Date.now() + 4230 * 60 * 1000).toISOString();
    try {
      await client
        .api(`/subscriptions/${user.microsoft_subscription_id}`)
        .patch({ expirationDateTime: newExpiry });

      await db.updateUser(user.id, { microsoft_subscription_expires: newExpiry });
      console.log(`Renewed webhook subscription for user ${user.id}`);
    } catch (err) {
      if (err.statusCode === 404) {
        console.log(`Subscription not found for user ${user.id}, recreating`);
        await setupEmailWebhook(user.id);
      } else {
        console.error(`Failed to renew subscription for user ${user.id}:`, err.message || err);
      }
    }
  }
}

// ─── Notification processing ──────────────────────────────────────────────────

async function processEmailNotification(userId, notification) {
  const user = await db.getUserById(parseInt(userId, 10));
  if (!user) return;

  const messageId = notification.resourceData?.id;
  if (!messageId) return;

  const client = await getGraphClient(user.id);
  if (!client) return;

  let email;
  try {
    email = await client
      .api(`/me/messages/${messageId}`)
      .select('id,subject,from,bodyPreview,importance')
      .get();
  } catch (err) {
    console.error(`Failed to fetch email ${messageId} for user ${userId}:`, err.message || err);
    return;
  }

  const emailMeta = {
    subject: email.subject || '',
    from: email.from?.emailAddress?.address || '',
    bodyPreview: email.bodyPreview || '',
  };

  const { important } = isEmailImportant(emailMeta);
  if (!important) return;

  const preview = emailMeta.bodyPreview
    ? ` — "${emailMeta.bodyPreview.slice(0, 100)}"`
    : '';
  await sms.sendMessage(
    user.phone_number,
    `heads up — new email from ${emailMeta.from}: ${emailMeta.subject}${preview}`,
    user.id
  );
}

// ─── Webhook handler (exported for index.js and tests) ───────────────────────

async function graphWebhookHandler(req, res) {
  // Validation handshake: Graph sends validationToken as query param
  if (req.query && req.query.validationToken) {
    return res.status(200).contentType('text/plain').send(req.query.validationToken);
  }

  // Return 202 immediately — Graph retries if response takes > 10 seconds
  res.status(202).send();

  const notifications = req.body?.value || [];
  for (const n of notifications) {
    const userId = n.clientState;
    if (!userId) continue;
    processEmailNotification(userId, n)
      .catch(e => console.error('graph notification error:', e.message || e));
  }
}

module.exports = {
  getGraphClient,
  getTodaysEvents,
  getUpcomingEvents,
  getUnreadEmails,
  isEmailImportant,
  getEmailBody,
  setupEmailWebhook,
  renewWebhookSubscriptions,
  processEmailNotification,
  graphWebhookHandler,
};
