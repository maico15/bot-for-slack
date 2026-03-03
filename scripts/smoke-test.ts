/**
 * Classification smoke tests.
 * Escalation is button-driven only — no auto-escalation logic to test here.
 * Run: npx ts-node scripts/smoke-test.ts
 */
import { classify } from '../src/intents';

const cases: Array<{
  label:           string;
  text:            string;
  expectIntentId:  string | null;
}> = [
  {
    label:          'twilio misspelling → outbound_call_error',
    text:           "I can't open my twillio",
    expectIntentId: 'outbound_call_error',
  },
  {
    label:          'white screen → white_screen_refresh',
    text:           'white screen when entering location',
    expectIntentId: 'white_screen_refresh',
  },
  {
    label:          'packet loss → packet_loss',
    text:           'choppy audio on all calls today',
    expectIntentId: 'packet_loss',
  },
  {
    label:          'error 45301 → agent_not_eligible_45301',
    text:           'getting error 45301 agent not eligible',
    expectIntentId: 'agent_not_eligible_45301',
  },
  {
    label:          'no inbound → inbound_missing',
    text:           'no inbound calls since 5am multiple agents',
    expectIntentId: 'inbound_missing',
  },
  {
    label:          'unrecognised message → null (FALLBACK_REPLY)',
    text:           'hello can you help me',
    expectIntentId: null,
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const intent   = classify(c.text);
  const intentId = intent?.id ?? null;
  const ok       = intentId === c.expectIntentId;

  console.log(`${ok ? '✓' : '✗'} ${c.label}`);
  if (!ok) console.log(`    got=${intentId ?? 'null'}  want=${c.expectIntentId ?? 'null'}`);
  ok ? passed++ : failed++;
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
