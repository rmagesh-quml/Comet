'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { generateUserMessage, classify } = require('./utils/claude');
const { sendTypingIndicator } = require('./sms');
const { searchMemories } = require('./memory/store');
const { getStyleContext } = require('./learning/styleAnalyzer');
const { captureConversationFeedback, captureProactiveFeedback } = require('./learning/feedbackCapture');
const { isDeletionRequest, requestDeletion } = require('./deletion');

const soulRaw = fs.readFileSync(path.join(__dirname, 'soul.md'), 'utf8');

function parseSoul() {
  const agentName = process.env.AGENT_NAME || 'Comet';
  return soulRaw.replace(/\$\{AGENT_NAME\}/g, agentName);
}

function parseAction(text) {
  const match = text.match(/\[ACTION:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/);
  if (!match) return null;
  return {
    type: match[1].trim(),
    data: match[2].trim(),
    message: match[3].trim(),
    raw: match[0],
  };
}

async function proposeAction(userId, action) {
  try {
    const parsed = JSON.parse(action.data);
    console.log(`Action proposed for userId=${userId}: ${action.type}`, parsed);
    // Action handling will be expanded as integrations are added
  } catch (err) {
    console.error('Failed to parse action data:', action.data, err.message);
  }
}

async function getGapContext(userId) {
  try {
    const lastMsg = await db.getLastUserMessageTime(userId);
    if (!lastMsg) return null;

    const hours = (Date.now() - new Date(lastMsg)) / 3600000;
    if (hours < 12) return null;
    if (hours < 24) return "user hasn't texted since yesterday";
    const days = Math.floor(hours / 24);
    if (days < 3) return `user hasn't texted in ${days} days`;
    return `user hasn't texted in ${days} days — a notable absence. acknowledge it warmly but don't make it weird`;
  } catch {
    return null;
  }
}

async function getResponse(userId, userMessage) {
  const user = await db.getUserById(userId);

  // Check for deletion request before anything else
  if (isDeletionRequest(userMessage)) {
    await requestDeletion(userId);
    return '';
  }

  // Fire typing indicator immediately — don't await
  sendTypingIndicator(user?.phone_number || '', userId);

  const [memories, styleContext, gapContext] = await Promise.all([
    searchMemories(userId, userMessage, 5).catch(() => []),
    getStyleContext(userId),
    getGapContext(userId),
  ]);

  const memoryBlock = memories.length > 0
    ? `\n\nWhat you remember about ${user?.name || 'this user'}:\n${memories.map(m => m.text).join('\n')}\nUse naturally. Don't recite back.`
    : '';

  const gapBlock = gapContext
    ? `\n\nNote: ${gapContext}. A real friend would notice — react naturally, don't ignore it.`
    : '';

  const systemPrompt =
    parseSoul() +
    (user?.name ? `\n\nUser's name: ${user.name}` : '') +
    (styleContext ? `\n\n${styleContext}` : '') +
    memoryBlock +
    gapBlock;

  // Get conversation history
  const history = await db.getRecentMessages(userId, 15);
  const messages = history.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  messages.push({ role: 'user', content: userMessage });

  const rawResponse = await generateUserMessage(systemPrompt, messages);

  // Parse and strip action tag
  const action = parseAction(rawResponse);
  let cleanResponse = rawResponse;
  if (action) {
    await proposeAction(userId, action);
    cleanResponse = rawResponse.replace(action.raw, '').trim();
  }

  // Persist both turns
  await db.saveMessage(userId, 'user', userMessage);
  await db.saveMessage(userId, 'assistant', cleanResponse);

  // Compact history if needed
  await compactHistory(userId);

  // Track morning brief engagement (fire and forget)
  db.updateMorningBriefEngagement(userId, userMessage.length).catch(() => {});

  // Get the previous agent message for conversation feedback
  const prevAgentResult = await db.query(
    `SELECT content FROM messages
     WHERE user_id = $1 AND role = 'assistant'
     ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
    [userId]
  );
  captureConversationFeedback(
    userId,
    userMessage,
    prevAgentResult.rows[0]?.content || null
  ).catch(() => {});

  // Capture feedback on recent proactive messages
  captureFeedback(userId, userMessage).catch(() => {});

  // Capture proactive feedback if applicable
  const lastSentResult = await db.query(
    `SELECT type, content FROM sent_messages
     WHERE user_id = $1
     AND type IN ('proactive','event_reminder','canvas_alert','health_nudge','nightly_digest','important_email_alert')
     AND created_at > NOW() - INTERVAL '30 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (lastSentResult.rows.length > 0) {
    const { type: trigType, content: trigContent } = lastSentResult.rows[0];
    captureProactiveFeedback(userId, trigType, hashContext(trigContent), userMessage).catch(() => {});
  }

  return cleanResponse;
}

function hashContext(text) {
  if (!text) return 'default';
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

async function captureFeedback(userId, userMessage) {
  const recentProactive = await db.getMostRecentProactiveSent(userId, 30);
  if (!recentProactive) return;

  // Extract triggerType and contextHash from type field: 'proactive:triggerType:contextHash'
  const parts = recentProactive.type.split(':');
  if (parts.length < 3) return;
  const triggerType = parts[1];
  const contextHash = parts[2];

  let sentiment;
  try {
    const raw = await classify(
      `Did this user reply positively, negatively, or neutrally to a proactive message?\nReturn JSON: {"sentiment": "positive"|"negative"|"neutral"}\nUser message: ${userMessage}`,
      50
    );
    const parsed = JSON.parse(raw.trim());
    sentiment = parsed.sentiment;
  } catch {
    return;
  }

  if (!['positive', 'negative', 'neutral'].includes(sentiment)) return;

  await db.updatePreference(userId, triggerType, contextHash, sentiment === 'positive');
}

async function compactHistory(userId) {
  const count = await db.getMessageCount(userId);
  if (count <= 20) return;

  const messages = await db.getRecentMessages(userId, count);
  const oldest = messages.slice(0, 10);

  const summaryPrompt =
    `Summarize this conversation snippet concisely in 2-3 sentences, capturing key facts and context:\n\n` +
    oldest.map(m => `${m.role}: ${m.content}`).join('\n');

  const summary = await classify(summaryPrompt);

  // Guard: don't delete messages if summarization failed or returned garbage
  if (!summary || summary.trim().length < 15) {
    console.warn(`[compactHistory] skipping compaction for user ${userId} — summary too short`);
    return;
  }

  const ids = oldest.map(m => m.id);
  await db.deleteMessages(userId, ids);
  await db.saveMessage(
    userId,
    'system',
    `[Summary of earlier conversation]: ${summary}`,
    true
  );
}

module.exports = { getResponse, compactHistory, hashContext, getGapContext };
