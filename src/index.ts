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

// ESCALATION_USER_ID receives a DM when a user clicks "Still not working".
// No automatic escalation occurs — all escalation is button-driven.

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
//        → root dedup → user cooldown → classify → reply → metrics
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
              text:      { type: 'plain_text', text: '✅ Resolved' },
              style:     'primary',
              action_id: 'resolved',
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

});

// ---------------------------------------------------------------------------
// Action: "✅ Resolved"
// ---------------------------------------------------------------------------
app.action<BlockAction>('resolved', async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const parsed = JSON.parse((action as any).value || '{}') as {
    channel?: string;
    thread_ts?: string;
  };
  if (!parsed.channel || !parsed.thread_ts) return;

  const metricsKey = `${parsed.channel}:${parsed.thread_ts}`;
  const entry      = metrics.get(metricsKey);
  if (entry) {
    entry.status    = 'solved';
    entry.updatedAt = Date.now();
  }

  await client.chat.postMessage({
    channel:   parsed.channel,
    thread_ts: parsed.thread_ts,
    text:      'Glad it is resolved! ✅',
  });
});

// ---------------------------------------------------------------------------
// Action: "Still not working" — asks for diagnostics + sends escalation DM
// ---------------------------------------------------------------------------
app.action<BlockAction>('still_not_working', async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const parsed = JSON.parse((action as any).value || '{}') as {
    channel?: string;
    thread_ts?: string;
  };
  if (!parsed.channel || !parsed.thread_ts) return;

  const metricsKey = `${parsed.channel}:${parsed.thread_ts}`;
  const entry      = metrics.get(metricsKey);

  // Idempotent — only escalate once
  if (entry?.escalated) {
    console.log(`[action] skip: already escalated metricsKey=${metricsKey}`);
    return;
  }

  // Mark immediately to prevent concurrent double-sends
  if (entry) {
    entry.status      = 'escalated';
    entry.escalated   = true;
    entry.escalatedAt = Date.now();
    entry.updatedAt   = Date.now();
  }

  // 1. Post diagnostics prompt in thread
  const diagResult = await client.chat.postMessage({
    channel:   parsed.channel,
    thread_ts: parsed.thread_ts,
    text:      'I have alerted the team. While they investigate, please reply with:',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            'I have alerted the team. While they investigate, please reply with:',
            '',
            '• *Browser + version:*',
            '• *Incognito tried:* Y / N',
            '• *Extensions disabled:* Y / N',
            '• *Error text or screenshot:*',
            '• *When did it start + how many agents affected:*',
          ].join('\n'),
        },
      },
    ],
  });
  if (diagResult.ts) {
    botMsgToThread.set(diagResult.ts, { metricsKey });
  }

  // 2. Send escalation DM to owner
  const rootTs = parsed.thread_ts;
  let permalink = `https://slack.com/archives/${parsed.channel}/p${rootTs.replace('.', '')}`;
  try {
    const pl = await client.chat.getPermalink({ channel: parsed.channel, message_ts: rootTs });
    if (pl.permalink) permalink = pl.permalink as string;
  } catch (err) {
    console.error(`[action] error fetching permalink metricsKey=${metricsKey}:`, err);
  }

  const ctx       = threadContexts.get(metricsKey);
  const intentId  = ctx?.intentId ?? entry?.intentId ?? 'unknown';
  const userText  = ctx?.userText ?? '';
  const truncated = userText.length > 500 ? `${userText.slice(0, 497)}\u2026` : userText;

  const dmLines = [
    '*Escalation — "Still not working" button*',
    `• *Intent:* ${intentId}`,
    `• *Reporter:* <@${ctx?.userId ?? 'unknown'}>`,
    `• *Channel:* <#${parsed.channel}>`,
    `• *Permalink:* ${permalink}`,
    `• *Original message:* ${truncated}`,
    `• *Bot replied:* ${ctx?.botReplyText ?? '(unknown)'}`,
    '',
    'Please check the thread — the user has been asked for diagnostics.',
  ];

  try {
    const { channel: dm } = await client.conversations.open({ users: ESCALATION_USER_ID });
    await client.chat.postMessage({ channel: dm!.id!, text: dmLines.join('\n') });
    console.log(`[action] escalation DM sent metricsKey=${metricsKey}`);
  } catch (err) {
    console.error(`[action] error sending escalation DM metricsKey=${metricsKey}:`, err);
  }
});

// ---------------------------------------------------------------------------
// Reaction tracking
// ✅ white_check_mark → set status 'solved'
// ❌ x               → set status 'unsolved'
// ---------------------------------------------------------------------------
app.event('reaction_added', async ({ event }) => {
  const { reaction } = event;
  const item = event.item;
  if (item.type !== 'message') return;

  const channel: string = (item as any).channel;
  const itemTs: string  = (item as any).ts;

  if (!ALLOWED_CHANNELS.includes(channel)) return;

  const metricsKey: string = botMsgToThread.get(itemTs)?.metricsKey ?? `${channel}:${itemTs}`;
  const entry = metrics.get(metricsKey);
  if (!entry) return;

  if (reaction === 'white_check_mark') {
    entry.status    = 'solved';
    entry.updatedAt = Date.now();
  } else if (reaction === 'x') {
    entry.status    = 'unsolved';
    entry.updatedAt = Date.now();
  }
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
