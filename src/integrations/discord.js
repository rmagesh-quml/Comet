'use strict';

/*
 * iOS Shortcut setup:
 * 1. Open Shortcuts app → New Shortcut
 * 2. Add action: "Get Contents of URL"
 *    - URL: https://<your-server>/discord-digest
 *    - Method: POST
 *    - Headers: X-Sync-Secret = <your HEALTH_SYNC_SECRET>, Content-Type = application/json
 *    - Body (JSON): { "phoneNumber": "<your number>", "messages": "<Shortcut Input>" }
 * 3. Add action: "Receive [Text] from Share Sheet" as the shortcut input
 * 4. Add the shortcut to your home screen
 * Usage: Copy Discord messages → tap shortcut from share sheet
 */

const db = require('../db');
const { classify } = require('../utils/claude');
const { sendMessage } = require('../sms');

async function handleDiscordDigest(req, res) {
  const secret = req.headers['x-sync-secret'];
  if (!secret || secret !== process.env.HEALTH_SYNC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { phoneNumber, messages } = req.body || {};
  if (!phoneNumber || !messages) {
    return res.status(400).json({ error: 'phoneNumber and messages required' });
  }

  const user = await db.getOrCreateUser(phoneNumber);

  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const prompt = `Extract signals from these Discord messages. Respond with JSON only:
{
  "deadlines": [{"task": "...", "dueDate": "...", "urgency": 1-10}],
  "studySessions": [{"subject": "...", "time": "...", "urgency": 1-10}],
  "socialPlans": [{"event": "...", "time": "...", "urgency": 1-10}],
  "stressSignals": [{"signal": "...", "urgency": 1-10}]
}

Messages:
${messages}`;

      let signals;
      try {
        const raw = await classify(prompt, 400);
        signals = JSON.parse(raw.trim());
      } catch {
        console.error('Discord digest: failed to parse classify response');
        return;
      }

      const urgent = [
        ...(signals.deadlines || []),
        ...(signals.studySessions || []),
        ...(signals.socialPlans || []),
        ...(signals.stressSignals || []),
      ].filter(s => (s.urgency || 0) >= 8);

      for (const item of urgent) {
        const text =
          item.task
            ? `heads up — deadline: ${item.task}${item.dueDate ? ` (due ${item.dueDate})` : ''}`
            : item.subject
            ? `study session: ${item.subject}${item.time ? ` at ${item.time}` : ''}`
            : item.event
            ? `plans: ${item.event}${item.time ? ` at ${item.time}` : ''}`
            : `stress signal: ${item.signal}`;

        await sendMessage(user.phone_number, text, user.id);
      }
    } catch (err) {
      console.error('Discord digest processing error:', err.message || err);
    }
  });
}

module.exports = { handleDiscordDigest };
