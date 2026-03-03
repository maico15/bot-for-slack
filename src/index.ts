import { App, ExpressReceiver, BlockAction, ButtonAction } from '@slack/bolt';
import * as dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNEL_IDS || '').split(',').map((id) => id.trim());
const OWNER_USER_ID = process.env.OWNER_USER_ID!;

const KEYWORDS = [
  'not working',
  "doesn't work",
  'error',
  'issue',
  'problem',
  'broken',
  'stuck',
  "can't",
  'unable to',
  'blank',
  'frozen',
  'loading',
];

// ---------------------------------------------------------------------------
// State
// TODO: Replace with Redis (with TTL support) for persistence across restarts
// ---------------------------------------------------------------------------
const respondedThreads = new Map<string, number>(); // threadKey → timestamp (ms)
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, ts] of respondedThreads) {
    if (ts < cutoff) respondedThreads.delete(key);
  }
}, 60 * 60 * 1000); // run cleanup every hour

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

// Health check
receiver.router.get('/', (_req, res) => {
  res.send('ok');
});

// ---------------------------------------------------------------------------
// Feature 1 – Keyword detection → Incognito prompt with action buttons
// ---------------------------------------------------------------------------
app.message(async ({ message, client }) => {
  const msg = message as any;

  // Ignore bot messages
  if (msg.bot_id || msg.subtype === 'bot_message') return;

  // Only act in the designated channel
  if (!ALLOWED_CHANNELS.includes(msg.channel)) return;

  const text: string = (msg.text ?? '').toLowerCase();
  if (!KEYWORDS.some((kw) => text.includes(kw))) return;

  // Deduplicate per thread – key is the thread root ts
  const threadKey: string = msg.thread_ts ?? msg.ts;
  if (respondedThreads.has(threadKey)) return;
  respondedThreads.set(threadKey, Date.now());

  const threadTs: string = msg.thread_ts ?? msg.ts;
  const buttonValue = JSON.stringify({ channel: msg.channel, thread_ts: threadTs });

  await client.chat.postMessage({
    channel: msg.channel,
    thread_ts: threadTs,
    text: 'Try Incognito mode (Ctrl+Shift+N) or clear your cache, then check if the issue persists.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Quick check:* Please try opening the page in *Incognito mode* (`Ctrl+Shift+N`) or *clear your browser cache*, then confirm if the issue persists.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'It works in Incognito' },
            style: 'primary',
            action_id: 'works_in_incognito',
            value: buttonValue,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Still not working' },
            style: 'danger',
            action_id: 'still_not_working',
            value: buttonValue,
          },
        ],
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Feature 2 – "It works in Incognito" → resolved reply
// ---------------------------------------------------------------------------
app.action<BlockAction>('works_in_incognito', async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const parsed = JSON.parse((action as any).value || '{}') as { channel?: string; thread_ts?: string };
  if (!parsed.channel || !parsed.thread_ts) return;

  await client.chat.postMessage({
    channel: parsed.channel,
    thread_ts: parsed.thread_ts,
    text: 'Resolved. The issue was likely caused by a browser extension or cached data. If it recurs, Incognito mode or clearing your cache should fix it.',
  });
});

// ---------------------------------------------------------------------------
// Feature 3 – "Still not working" → ask for 3 details
// ---------------------------------------------------------------------------
app.action<BlockAction>('still_not_working', async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const parsed = JSON.parse((action as any).value || '{}') as { channel?: string; thread_ts?: string };
  if (!parsed.channel || !parsed.thread_ts) return;

  await client.chat.postMessage({
    channel: parsed.channel,
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
});

// ---------------------------------------------------------------------------
// Feature 4 – /flex escalate
// ---------------------------------------------------------------------------
app.command('/flex', async ({ ack, command, client }) => {
  await ack();

  if (command.text.trim().toLowerCase() !== 'escalate') {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: 'Unknown subcommand. Usage: `/flex escalate`',
    });
    return;
  }

  const { channel_id, user_id, user_name } = command;
  const rawThreadTs: string | undefined = (command as any).thread_ts;

  const threadLink = rawThreadTs
    ? `https://slack.com/archives/${channel_id}/p${rawThreadTs.replace('.', '')}`
    : `https://slack.com/archives/${channel_id}`;

  // DM the owner
  const { channel: dm } = await client.conversations.open({ users: OWNER_USER_ID });
  await client.chat.postMessage({
    channel: dm!.id!,
    text: [
      '*Escalation Request*',
      `• *Reporter:* <@${user_id}> (${user_name})`,
      `• *Channel:* <#${channel_id}>`,
      `• *Timestamp:* ${new Date().toISOString()}`,
      `• *Thread link:* ${threadLink}`,
    ].join('\n'),
  });

  // Confirm in channel
  await client.chat.postMessage({
    channel: channel_id,
    text: 'Escalated to System Owner.',
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  const port = Number(process.env.PORT) || 3000;
  await app.start(port);
  console.log(`⚡️ System Assistant is running on port ${port}`);
})();
