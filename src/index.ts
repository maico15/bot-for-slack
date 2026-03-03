import { App, ExpressReceiver, BlockAction, ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import * as dotenv from 'dotenv';
import {
  seenEventIds, handledRoots, userCooldown, metrics, upsertMetric,
  threadContexts, botMsgToThread,
  computeStats, startCleanup,
  type Diagnostics,
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

// ESCALATION_USER_ID receives a DM only after the user completes the diagnostic
// modal and clicks "Escalate to support". No automatic escalation.

// Intents that get an extra network-quality step (step 4) in the modal.
const NETWORK_INTENTS = new Set(['packet_loss', 'attempting_reconnect']);

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

/** private_metadata shape passed through every modal step */
type Meta = { channelId: string; rootTs: string };

/** Minimal typing for Slack modal view objects */
interface ModalView {
  type:              'modal';
  callback_id:       string;
  private_metadata:  string;
  title:             { type: 'plain_text'; text: string };
  submit?:           { type: 'plain_text'; text: string };
  close?:            { type: 'plain_text'; text: string };
  blocks:            object[];
}

const YES_NO_OPTIONS = [
  { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
  { text: { type: 'plain_text', text: 'No'  }, value: 'no'  },
];

function buildStep1Modal(meta: string): ModalView {
  return {
    type: 'modal', callback_id: 'diag_step_1', private_metadata: meta,
    title:  { type: 'plain_text', text: 'Diagnostics (1 / 3)' },
    submit: { type: 'plain_text', text: 'Next' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'browser',
        label: { type: 'plain_text', text: 'Browser + version' },
        element: {
          type: 'plain_text_input', action_id: 'browser_version',
          placeholder: { type: 'plain_text', text: 'e.g. Chrome 125, Edge 124' },
        },
      },
      {
        type: 'input', block_id: 'incognito',
        label: { type: 'plain_text', text: 'Tried in Incognito / private window?' },
        element: {
          type: 'static_select', action_id: 'incognito_select',
          placeholder: { type: 'plain_text', text: 'Select' },
          options: YES_NO_OPTIONS,
        },
      },
    ],
  };
}

function buildStep2Modal(meta: string): ModalView {
  return {
    type: 'modal', callback_id: 'diag_step_2', private_metadata: meta,
    title:  { type: 'plain_text', text: 'Diagnostics (2 / 3)' },
    submit: { type: 'plain_text', text: 'Next' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'extensions',
        label: { type: 'plain_text', text: 'Extensions disabled?' },
        element: {
          type: 'static_select', action_id: 'extensions_select',
          placeholder: { type: 'plain_text', text: 'Select' },
          options: YES_NO_OPTIONS,
        },
      },
      {
        type: 'input', block_id: 'error', optional: true,
        label: { type: 'plain_text', text: 'Error text or screenshot link' },
        element: {
          type: 'plain_text_input', action_id: 'error_text', multiline: true,
          placeholder: { type: 'plain_text', text: 'Paste error message or link (optional)' },
        },
      },
    ],
  };
}

function buildStep3Modal(meta: string): ModalView {
  return {
    type: 'modal', callback_id: 'diag_step_3', private_metadata: meta,
    title:  { type: 'plain_text', text: 'Diagnostics (3 / 3)' },
    submit: { type: 'plain_text', text: 'Next' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'started',
        label: { type: 'plain_text', text: 'When did the issue start?' },
        element: {
          type: 'plain_text_input', action_id: 'started_when',
          placeholder: { type: 'plain_text', text: 'e.g. today at 9am, after yesterday\'s update' },
        },
      },
      {
        type: 'input', block_id: 'affected',
        label: { type: 'plain_text', text: 'How many agents are affected?' },
        element: {
          type: 'plain_text_input', action_id: 'agents_affected',
          placeholder: { type: 'plain_text', text: 'e.g. 1, ~5, all agents' },
        },
      },
    ],
  };
}

function buildStep4Modal(meta: string): ModalView {
  return {
    type: 'modal', callback_id: 'diag_step_4', private_metadata: meta,
    title:  { type: 'plain_text', text: 'Network Details' },
    submit: { type: 'plain_text', text: 'Review' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'latency', optional: true,
        label: { type: 'plain_text', text: 'Twilio Network Test — Latency (ms)' },
        element: {
          type: 'plain_text_input', action_id: 'latency_ms',
          placeholder: { type: 'plain_text', text: 'e.g. 142' },
        },
      },
      {
        type: 'input', block_id: 'loss', optional: true,
        label: { type: 'plain_text', text: 'Twilio Network Test — Packet loss (%)' },
        element: {
          type: 'plain_text_input', action_id: 'packet_loss',
          placeholder: { type: 'plain_text', text: 'e.g. 2.5' },
        },
      },
    ],
  };
}

function buildConfirmModal(meta: string, diag: Diagnostics, intentId: string): ModalView {
  const yn = (v?: boolean) => v === true ? 'Yes' : v === false ? 'No' : '—';
  const isNetwork = NETWORK_INTENTS.has(intentId);
  const lines = [
    `• *Browser:* ${diag.browserVersion ?? '—'}`,
    `• *Incognito tried:* ${yn(diag.incognitoTried)}`,
    `• *Extensions disabled:* ${yn(diag.extensionsDisabled)}`,
    `• *Error text:* ${diag.errorText || '—'}`,
    `• *Started when:* ${diag.startedWhen ?? '—'}`,
    `• *Agents affected:* ${diag.agentsAffected ?? '—'}`,
    ...(isNetwork ? [
      `• *Network latency (ms):* ${diag.networkLatency || '—'}`,
      `• *Packet loss (%):* ${diag.networkPacketLoss || '—'}`,
    ] : []),
  ];
  return {
    type: 'modal', callback_id: 'diag_confirm', private_metadata: meta,
    title:  { type: 'plain_text', text: 'Review & Escalate' },
    submit: { type: 'plain_text', text: 'Escalate to support' },
    close:  { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Review your diagnostics before escalating:*\n\n' + lines.join('\n') },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Escalation DM helper — called only from diag_confirm view handler
// ---------------------------------------------------------------------------
async function sendEscalationDM(
  client: WebClient,
  channelId: string,
  rootTs: string,
  userId: string,
  intentId: string,
  originalText: string,
  diag: Diagnostics,
): Promise<void> {
  let permalink = `https://slack.com/archives/${channelId}/p${rootTs.replace('.', '')}`;
  try {
    const pl = await client.chat.getPermalink({ channel: channelId, message_ts: rootTs });
    if (pl.permalink) permalink = pl.permalink as string;
  } catch { /* non-fatal — fall back to constructed URL */ }

  const yn = (v?: boolean) => v === true ? 'Yes' : v === false ? 'No' : '—';
  const truncated = originalText.length > 500
    ? `${originalText.slice(0, 497)}\u2026`
    : originalText;

  const dmLines = [
    '*Escalation — user confirmed via modal*',
    `• *Intent:* ${intentId}`,
    `• *Reporter:* <@${userId}>`,
    `• *Channel:* <#${channelId}>`,
    `• *Permalink:* ${permalink}`,
    `• *Original message:* ${truncated}`,
    '',
    '*Diagnostics:*',
    `• *Browser:* ${diag.browserVersion ?? '—'}`,
    `• *Incognito tried:* ${yn(diag.incognitoTried)}`,
    `• *Extensions disabled:* ${yn(diag.extensionsDisabled)}`,
    `• *Error text:* ${diag.errorText || '—'}`,
    `• *Started when:* ${diag.startedWhen ?? '—'}`,
    `• *Agents affected:* ${diag.agentsAffected ?? '—'}`,
    ...(diag.networkLatency    ? [`• *Network latency (ms):* ${diag.networkLatency}`]    : []),
    ...(diag.networkPacketLoss ? [`• *Packet loss (%):* ${diag.networkPacketLoss}`] : []),
    '',
    'Please check the thread for any additional context from the user.',
  ];

  const { channel: dm } = await client.conversations.open({ users: ESCALATION_USER_ID });
  await client.chat.postMessage({ channel: dm!.id!, text: dmLines.join('\n') });
}

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
    status:      'open',
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    userId:      msg.user,
    channelId:   msg.channel,
    rootTs,
    originalText: text,
    botReplyTs:  botMsgTs,
  });

});

// ---------------------------------------------------------------------------
// reactions.add capability cache
// Populated on first attempt — avoids noisy errors when reactions:write
// scope is absent. To enable ✅ reactions, add reactions:write to your
// Slack app's OAuth scopes.
// ---------------------------------------------------------------------------
let reactionsWriteAllowed: boolean | undefined;

const REACTIONS_PERM_ERRORS = new Set([
  'missing_scope', 'not_allowed_token_type',
  'restricted_action', 'not_authed', 'invalid_auth',
]);

async function addCheckMark(client: WebClient, channel: string, timestamp: string): Promise<void> {
  if (reactionsWriteAllowed === false) return; // permission absent — skip silently

  try {
    await client.reactions.add({ channel, timestamp, name: 'white_check_mark' });
    reactionsWriteAllowed = true;
  } catch (err: any) {
    const code: string = err?.data?.error ?? '';

    if (code === 'already_reacted') {
      reactionsWriteAllowed = true;
      return;
    }
    if (REACTIONS_PERM_ERRORS.has(code)) {
      // Log once — future calls return early at the top before reaching here
      console.info(`[reactions] reactions:write unavailable (${code}) — add the scope to enable ✅ reactions.`);
      reactionsWriteAllowed = false;
      return;
    }
    // Unexpected error — warn but don't cache; may be transient
    console.warn(`[reactions] reactions.add failed (${code || String(err)})`);
  }
}

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

  const { channel, thread_ts: rootTs } = parsed;
  const metricsKey = `${channel}:${rootTs}`;
  const entry      = metrics.get(metricsKey);

  // Idempotent — only act once
  if (entry?.resolvedNotified) {
    console.log(`[resolved] skip: already resolved key=${metricsKey}`);
    return;
  }

  // Update state atomically before async work
  upsertMetric(metricsKey, {
    status:            'solved',
    solvedAt:          Date.now(),
    resolvedNotified:  true,
  });

  // Add ✅ reaction to the original root message (skips silently if scope absent)
  await addCheckMark(client, channel, rootTs);

  // Post confirmation in thread (once, guarded by resolvedNotified above)
  try {
    await client.chat.postMessage({
      channel,
      thread_ts: rootTs,
      text:      'Great — marking this as resolved ✅',
    });
  } catch (err) {
    console.error(`[resolved] thread post failed key=${metricsKey}:`, err);
  }

  // Replace the bot's initial reply buttons with a "Status: Resolved ✅" context block
  const updated    = metrics.get(metricsKey);
  const ctx        = threadContexts.get(metricsKey);
  const replyText  = ctx?.botReplyText ?? 'Your issue has been reviewed.';
  if (updated?.botReplyTs) {
    try {
      await client.chat.update({
        channel,
        ts:     updated.botReplyTs,
        text:   replyText,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: replyText } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Status: Resolved ✅' }] },
        ],
      });
    } catch (err) {
      console.error(`[resolved] chat.update failed key=${metricsKey}:`, err);
    }
  }
});

// ---------------------------------------------------------------------------
// Action: "Still not working" — opens diagnostic modal (step 1)
// No DM is sent here. Escalation happens only after the user confirms
// in the final modal step ("Escalate to support" button).
//
// Smoke-test: post any message in an allowed channel, click "Still not working"
//   → modal should open titled "Diagnostics (1 / 3)"
//   → clicking Cancel closes with no side-effects
//   → completing all steps and clicking "Escalate to support" sends exactly one DM
// ---------------------------------------------------------------------------
app.action<BlockAction>('still_not_working', async ({ ack, body, client }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const parsed = JSON.parse((action as any).value || '{}') as {
    channel?: string;
    thread_ts?: string;
  };
  if (!parsed.channel || !parsed.thread_ts) return;

  const { channel, thread_ts: rootTs } = parsed;
  const metricsKey = `${channel}:${rootTs}`;
  const entry      = metrics.get(metricsKey);

  // Already escalated — tell user and bail (no modal)
  if (entry?.escalated) {
    await client.chat.postEphemeral({
      channel,
      user: (body as any).user?.id ?? '',
      text: 'This thread has already been escalated. The team is looking into it.',
    });
    return;
  }

  // Mark as collecting so concurrent button clicks don't race
  upsertMetric(metricsKey, { status: 'collecting' });

  const meta = JSON.stringify({ channelId: channel, rootTs } satisfies Meta);
  try {
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: buildStep1Modal(meta) as any,
    });
  } catch (err) {
    console.error(`[action] views.open failed key=${metricsKey}:`, err);
  }
});

// ---------------------------------------------------------------------------
// Modal view handlers
// Each intermediate step acks with response_action:'update' so the same modal
// window updates in place (no flicker, single trigger_id consumed).
// ---------------------------------------------------------------------------

// Step 1 → step 2 : browser + incognito
app.view('diag_step_1', async ({ ack, view }) => {
  const { channelId, rootTs } = JSON.parse(view.private_metadata) as Meta;
  const vals = view.state.values as Record<string, Record<string, any>>;

  upsertMetric(`${channelId}:${rootTs}`, {
    diagnostics: {
      browserVersion: vals['browser']['browser_version'].value ?? '',
      incognitoTried: vals['incognito']['incognito_select'].selected_option?.value === 'yes',
    },
  });

  await ack({ response_action: 'update', view: buildStep2Modal(view.private_metadata) } as any);
});

// Step 2 → step 3 : extensions + error text
app.view('diag_step_2', async ({ ack, view }) => {
  const { channelId, rootTs } = JSON.parse(view.private_metadata) as Meta;
  const vals = view.state.values as Record<string, Record<string, any>>;

  upsertMetric(`${channelId}:${rootTs}`, {
    diagnostics: {
      extensionsDisabled: vals['extensions']['extensions_select'].selected_option?.value === 'yes',
      errorText:          vals['error']['error_text'].value ?? undefined,
    },
  });

  await ack({ response_action: 'update', view: buildStep3Modal(view.private_metadata) } as any);
});

// Step 3 → step 4 (network intents) OR confirm modal
app.view('diag_step_3', async ({ ack, view }) => {
  const { channelId, rootTs } = JSON.parse(view.private_metadata) as Meta;
  const vals = view.state.values as Record<string, Record<string, any>>;

  const entry = upsertMetric(`${channelId}:${rootTs}`, {
    status: 'ready',
    diagnostics: {
      startedWhen:    vals['started']['started_when'].value ?? '',
      agentsAffected: vals['affected']['agents_affected'].value ?? '',
    },
  });

  const next = NETWORK_INTENTS.has(entry.intentId)
    ? buildStep4Modal(view.private_metadata)
    : buildConfirmModal(view.private_metadata, entry.diagnostics ?? {}, entry.intentId);

  await ack({ response_action: 'update', view: next } as any);
});

// Step 4 (network) → confirm modal
app.view('diag_step_4', async ({ ack, view }) => {
  const { channelId, rootTs } = JSON.parse(view.private_metadata) as Meta;
  const vals = view.state.values as Record<string, Record<string, any>>;

  const entry = upsertMetric(`${channelId}:${rootTs}`, {
    diagnostics: {
      networkLatency:    vals['latency']['latency_ms'].value ?? undefined,
      networkPacketLoss: vals['loss']['packet_loss'].value ?? undefined,
    },
  });

  await ack({
    response_action: 'update',
    view: buildConfirmModal(view.private_metadata, entry.diagnostics ?? {}, entry.intentId),
  } as any);
});

// Confirm → send DM + post in thread
// This is the ONLY place where ESCALATION_USER_ID receives a DM.
app.view('diag_confirm', async ({ ack, view, client }) => {
  await ack(); // close modal immediately; async work follows

  const { channelId, rootTs } = JSON.parse(view.private_metadata) as Meta;
  const key   = `${channelId}:${rootTs}`;
  const entry = metrics.get(key);
  if (!entry) return;

  // Idempotent — guard against double-submit race
  if (entry.escalated) {
    console.log(`[diag_confirm] skip: already escalated key=${key}`);
    return;
  }

  upsertMetric(key, { status: 'escalated', escalated: true, escalatedAt: Date.now() });

  try {
    const updated = metrics.get(key)!;
    await sendEscalationDM(
      client,
      channelId,
      rootTs,
      updated.userId       ?? 'unknown',
      updated.intentId,
      updated.originalText ?? '',
      updated.diagnostics  ?? {},
    );
    console.log(`[diag_confirm] escalation DM sent key=${key}`);
  } catch (err) {
    console.error(`[diag_confirm] DM failed key=${key}:`, err);
  }

  try {
    await client.chat.postMessage({
      channel:   channelId,
      thread_ts: rootTs,
      text:      'Escalated ✅. Thanks — the team will take a look.',
    });
  } catch (err) {
    console.error(`[diag_confirm] thread post failed key=${key}:`, err);
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
