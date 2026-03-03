import { App, ExpressReceiver, BlockAction, ButtonAction } from '@slack/bolt';
import * as dotenv from 'dotenv';
import {
  seenEventIds, handledRoots, userCooldown, metrics,
  threadContexts, botMsgToThread,
  computeStats, startCleanup,
} from './store';
import { classify, FALLBACK_REPLY } from './intents';

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ALLOWED_CHANNELS = (process.env.CHANNEL_ALLOWLIST || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (ALLOWED_CHANNELS.length === 0) {
  console.warn('[config] WARNING: CHANNEL_ALLOWLIST is empty — bot will not respond to any messages.');
}

const ESCALATION_USER_ID = process.env.ESCALATION_USER_ID!;

// Keywords and reply templates are defined in config/intents.yml.
// ESCALATION_KEYWORDS: optional comma-separated regex parts that trigger an
// escalation DM independently of the intent's own escalation flag.
// Falls back to DEFAULT_ESCALATION_RE when the env var is not set.
const DEFAULT_ESCALATION_RE = /mass issue|outage|multiple agents|many agents|since\s+\d|abandoned rate|sev\d|urgent|down|not receiving inbound/i;

const ESCALATION_KEYWORD_RE: RegExp = (() => {
  const raw = (process.env.ESCALATION_KEYWORDS || '').trim();
  if (!raw) return DEFAULT_ESCALATION_RE;
  const parts = raw.split(',').map((k) => k.trim()).filter(Boolean);
  if (parts.length === 0) return DEFAULT_ESCALATION_RE;
  try {
    return new RegExp(`(${parts.join('|')})`, 'i');
  } catch (err) {
    console.warn(`[config] Invalid ESCALATION_KEYWORDS, falling back to default: ${err}`);
    return DEFAULT_ESCALATION_RE;
  }
})();

// ---------------------------------------------------------------------------
// Receiver + App
// ---------------------------------------------------------------------------
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  receiver,
});

receiver.router.get('/', (_req, res) => res.send('ok'));

// ---------------------------------------------------------------------------
// Message handler
// Order: bot filter → thread-reply filter → channel → event_id dedup
//        → root dedup → user cooldown → classify → reply → metrics → escalation
// ---------------------------------------------------------------------------
app.message(async ({ message, client, body }) => {
  const msg     = message as any;
  const eventId = ((body as any).event_id ?? '') as string;

  // 1. Ignore bot messages
  if (msg.bot_id || msg.subtype === 'bot_message') {
    console.log(`[msg] skip bot_message event_id=${eventId}`);
    return;
  }

  // 2. Root messages only — skip thread replies (thread_ts present AND != ts)
  if (msg.thread_ts && msg.thread_ts !== msg.ts) {
    console.log(`[msg] skip thread reply ts=${msg.ts} parent=${msg.thread_ts}`);
    return;
  }

  // 3. Channel allowlist
  if (!ALLOWED_CHANNELS.includes(msg.channel)) {
    console.log(`[msg] skip channel=${msg.channel} not in allowlist`);
    return;
  }

  // 4. Event-level dedup (30 min) — guards against Slack retry deliveries
  if (eventId) {
    if (seenEventIds.has(eventId)) {
      console.log(`[msg] skip duplicate event_id=${eventId}`);
      return;
    }
    seenEventIds.set(eventId, true);
  }

  // rootTs === event.ts because we only reach here for root messages
  const rootTs:     string = msg.ts;
  const metricsKey: string = `${msg.channel}:${rootTs}`;

  // 5. Root dedup (24 h)
  if (handledRoots.has(metricsKey)) {
    console.log(`[msg] skip already handled root=${metricsKey}`);
    return;
  }

  // 6. User cooldown (90 s) — checked after root dedup to avoid consuming
  //    a cooldown slot for threads we would have skipped anyway
  if (userCooldown.has(msg.user)) {
    console.log(`[msg] skip user=${msg.user} in cooldown`);
    return;
  }

  // Commit dedup state before any async work
  handledRoots.set(metricsKey, true);
  userCooldown.set(msg.user, true);

  // 7. Classify — fall back to FALLBACK_REPLY when no intent matches
  const text:         string = msg.text ?? '';
  const intent               = classify(text);
  const intentId:     string = intent?.id ?? 'unknown';
  const replyTemplate:string = intent?.replyTemplate ?? FALLBACK_REPLY;
  const buttonValue:  string = JSON.stringify({ channel: msg.channel, thread_ts: rootTs });

  // 8. Post reply in thread (thread_ts = rootTs = event.ts)
  let botMsgTs: string | undefined;
  try {
    const result = await client.chat.postMessage({
      channel:   msg.channel,
      thread_ts: rootTs,
      text:      replyTemplate,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: replyTemplate } },
        {
          type: 'actions',
          elements: [
            {
              type:      'button',
              text:      { type: 'plain_text', text: 'It works in Incognito' },
              style:     'primary',
              action_id: 'works_in_incognito',
              value:     buttonValue,
            },
            {
              type:      'button',
              text:      { type: 'plain_text', text: 'Still not working' },
              style:     'danger',
              action_id: 'still_not_working',
              value:     buttonValue,
            },
          ],
        },
      ],
    });
    botMsgTs = result.ts;
  } catch (err) {
    console.error(`[msg] error posting reply root=${metricsKey}:`, err);
  }

  if (botMsgTs) botMsgToThread.set(botMsgTs, { metricsKey });

  threadContexts.set(metricsKey, {
    userId:       msg.user,
    userText:     text,
    botReplyText: replyTemplate,
    intentId,
  });

  // 9. Record metrics (intentId = 'unknown' when no pattern matched)
  metrics.set(metricsKey, {
    intentId,
    status:    'open',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // 10. Escalation DM
  // Trigger A: intent declares escalation: true
  // Trigger B: text matches ESCALATION_KEYWORD_RE from env
  const needsEscalation =
    (intent?.escalation === true) ||
    ESCALATION_KEYWORD_RE.test(text);

  if (!needsEscalation) return;

  const entry = metrics.get(metricsKey);
  if (entry?.escalated) {
    console.log(`[msg] skip escalation DM: already escalated root=${metricsKey}`);
    return;
  }

  // Mark before sending to prevent double-send on concurrent retries
  if (entry) { entry.escalated = true; entry.updatedAt = Date.now(); }

  let permalink = `https://slack.com/archives/${msg.channel}/p${rootTs.replace('.', '')}`;
  try {
    const pl = await client.chat.getPermalink({ channel: msg.channel, message_ts: rootTs });
    if (pl.permalink) permalink = pl.permalink as string;
  } catch (err) {
    console.error(`[msg] error fetching permalink root=${metricsKey}:`, err);
  }

  const truncated = text.length > 1000 ? `${text.slice(0, 997)}\u2026` : text;
  const dmLines = [
    '*Auto-Escalation*',
    `• *Intent:* ${intentId}`,
    `• *Reporter:* <@${msg.user}>`,
    `• *Channel:* <#${msg.channel}>`,
    `• *Permalink:* ${permalink}`,
    `• *Message:* ${truncated}`,
    `• *Bot replied:* ${replyTemplate}`,
  ];

  try {
    const { channel: dm } = await client.conversations.open({ users: ESCALATION_USER_ID });
    await client.chat.postMessage({ channel: dm!.id!, text: dmLines.join('\n') });
    console.log(`[msg] escalation DM sent intent=${intentId} root=${metricsKey}`);
  } catch (err) {
    console.error(`[msg] error sending escalation DM root=${metricsKey}:`, err);
  }
});

// ---------------------------------------------------------------------------
// Action: "It works in Incognito"
// ---------------------------------------------------------------------------
app.action<BlockAction>('works_in_incognito', async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const parsed = JSON.parse((action as any).value || '{}') as {
    channel?: string;
    thread_ts?: string;
  };
  if (!parsed.channel || !parsed.thread_ts) return;

  const result = await client.chat.postMessage({
    channel:   parsed.channel,
    thread_ts: parsed.thread_ts,
    text: 'Resolved. The issue was likely caused by a browser extension or cached data. If it recurs, Incognito mode or clearing your cache should fix it.',
  });
  if (result.ts) {
    botMsgToThread.set(result.ts, { metricsKey: `${parsed.channel}:${parsed.thread_ts}` });
  }
});

// ---------------------------------------------------------------------------
// Action: "Still not working"
// ---------------------------------------------------------------------------
app.action<BlockAction>('still_not_working', async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const parsed = JSON.parse((action as any).value || '{}') as {
    channel?: string;
    thread_ts?: string;
  };
  if (!parsed.channel || !parsed.thread_ts) return;

  const result = await client.chat.postMessage({
    channel:   parsed.channel,
    thread_ts: parsed.thread_ts,
    text: 'Please share these details so we can investigate.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            'To investigate further, please reply with:',
            '',
            '1. *Browser* — Chrome / Firefox / Edge / Safari',
            '2. *What is not working?* — Booking / Leads / SMS / Queue / Calls / Other',
            '3. *Multiple agents affected?* — Yes / No',
          ].join('\n'),
        },
      },
    ],
  });
  if (result.ts) {
    botMsgToThread.set(result.ts, { metricsKey: `${parsed.channel}:${parsed.thread_ts}` });
  }
});

// ---------------------------------------------------------------------------
// Reaction tracking
// ✅ white_check_mark → set status 'solved'
// ❌ x               → set status 'unsolved'
// 🧵 thread          → escalation DM to ESCALATION_USER_ID (once per root)
// Missing metrics entry is created with intentId 'unknown', status 'open'.
// ---------------------------------------------------------------------------
app.event('reaction_added', async ({ event, client }) => {
  const { reaction, user } = event;
  const item = event.item;
  if (item.type !== 'message') return;

  const channel: string = (item as any).channel;
  const itemTs: string  = (item as any).ts;

  if (!ALLOWED_CHANNELS.includes(channel)) return;

  // Resolve to the root message via botMsgToThread; fall back to itemTs itself
  const metricsKey: string = botMsgToThread.get(itemTs)?.metricsKey ?? `${channel}:${itemTs}`;
  const rootTs: string     = metricsKey.slice(metricsKey.indexOf(':') + 1);

  // Get or create metrics entry (reaction may arrive on a message the bot never saw)
  let entry = metrics.get(metricsKey);
  if (!entry) {
    entry = { intentId: 'unknown', status: 'open', createdAt: Date.now(), updatedAt: Date.now() };
    metrics.set(metricsKey, entry);
  }

  if (reaction === 'white_check_mark') {
    entry.status    = 'solved';
    entry.updatedAt = Date.now();
    return;
  }

  if (reaction === 'x') {
    entry.status    = 'unsolved';
    entry.updatedAt = Date.now();
    return;
  }

  if (reaction !== 'thread') return;

  // 🧵 manual escalation — once per root message (unified flag with auto-escalation)
  if (entry.escalated) return;
  entry.escalated = true;
  entry.updatedAt = Date.now();

  let permalink = `https://slack.com/archives/${channel}/p${rootTs.replace('.', '')}`;
  try {
    const pl = await client.chat.getPermalink({ channel, message_ts: rootTs });
    if (pl.permalink) permalink = pl.permalink as string;
  } catch (err) {
    console.error(`[reaction] error fetching permalink metricsKey=${metricsKey}:`, err);
  }

  const ctx = threadContexts.get(metricsKey);
  const lines = [
    '*Manual Escalation (🧵 reaction)*',
    `• *Escalated by:* <@${user}>`,
    `• *Channel:* <#${channel}>`,
    `• *Permalink:* ${permalink}`,
    `• *Intent:* ${entry.intentId}`,
  ];
  if (ctx) {
    lines.push(`• *Reporter:* <@${ctx.userId}>`);
    lines.push(`• *Original message:* ${ctx.userText}`);
    lines.push(`• *Bot replied:* ${ctx.botReplyText}`);
  }

  try {
    const { channel: dm } = await client.conversations.open({ users: ESCALATION_USER_ID });
    await client.chat.postMessage({ channel: dm!.id!, text: lines.join('\n') });
    console.log(`[reaction] escalation DM sent metricsKey=${metricsKey}`);
  } catch (err) {
    console.error(`[reaction] error sending escalation DM metricsKey=${metricsKey}:`, err);
  }
});

// ---------------------------------------------------------------------------
// /flex escalate — manual escalation command
// ---------------------------------------------------------------------------
app.command('/flex', async ({ ack, command, client }) => {
  await ack();

  if (command.text.trim().toLowerCase() !== 'escalate') {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user:    command.user_id,
      text:    'Unknown subcommand. Usage: `/flex escalate`',
    });
    return;
  }

  const { channel_id, user_id, user_name } = command;
  const rawThreadTs: string | undefined = (command as any).thread_ts;

  // Prefer real permalink from API; fall back to constructed URL
  let permalink = rawThreadTs
    ? `https://slack.com/archives/${channel_id}/p${rawThreadTs.replace('.', '')}`
    : `https://slack.com/archives/${channel_id}`;
  if (rawThreadTs) {
    try {
      const pl = await client.chat.getPermalink({
        channel:    channel_id,
        message_ts: rawThreadTs,
      });
      if (pl.permalink) permalink = pl.permalink as string;
    } catch { /* non-fatal */ }
  }

  const metricsKey = rawThreadTs ? `${channel_id}:${rawThreadTs}` : undefined;
  const ctx = metricsKey ? threadContexts.get(metricsKey) : undefined;

  if (metricsKey) {
    const entry = metrics.get(metricsKey);
    if (entry) { entry.escalated = true; entry.updatedAt = Date.now(); }
  }

  const lines = [
    '*Escalation Request*',
    `• *Reporter:* <@${user_id}> (${user_name})`,
    `• *Channel:* <#${channel_id}>`,
    `• *Timestamp:* ${new Date().toISOString()}`,
    `• *Permalink:* ${permalink}`,
  ];
  if (ctx) {
    lines.push(`• *Intent:* ${ctx.intentId}`);
    lines.push(`• *Original message:* ${ctx.userText}`);
    lines.push(`• *Bot replied:* ${ctx.botReplyText}`);
  }

  const { channel: dm } = await client.conversations.open({ users: ESCALATION_USER_ID });
  await client.chat.postMessage({ channel: dm!.id!, text: lines.join('\n') });

  await client.chat.postMessage({
    channel: channel_id,
    text: 'Escalated to System Owner.',
  });
});

// ---------------------------------------------------------------------------
// /flexbot stats — in-memory stats (last 7 days), visible only to caller
// NOTE: register /flexbot as a slash command in your Slack app config
// ---------------------------------------------------------------------------
app.command('/flexbot', async ({ ack, command, client }) => {
  await ack();

  if (command.text.trim().toLowerCase() !== 'stats') {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user:    command.user_id,
      text:    'Unknown subcommand. Usage: `/flexbot stats`',
    });
    return;
  }

  await client.chat.postEphemeral({
    channel: command.channel_id,
    user:    command.user_id,
    text:    computeStats(),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  const port = Number(process.env.PORT) || 3000;
  await app.start(port);
  startCleanup();
  console.log(`⚡️ System Assistant v2.0 running on port ${port}`);
})();
