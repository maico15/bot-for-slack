/**
 * Escalation + classification smoke tests.
 * Run: npx ts-node scripts/smoke-test.ts
 */
import { classify } from '../src/intents';

// Must mirror DEFAULT_ESCALATION_RE in src/index.ts exactly.
const KEYWORD_RE =
  /\b(outage|mass\s+issue|multiple\s+agents|many\s+agents|no\s+inbound|not\s+receiving\s+inbound|since\s+\d{1,2}(:\d{2})?\s*(am|pm)?|abandoned\s+rate|sev\d)\b/i;

function shouldEscalate(text: string): boolean {
  const intent = classify(text);
  return intent !== null ? Boolean(intent.escalation) : KEYWORD_RE.test(text);
}

const cases: Array<{
  label:             string;
  text:              string;
  expectIntentId:    string | null;
  expectEscalation:  boolean;
}> = [
  {
    label:            'known intent escalation:false — no escalation despite noisy text',
    text:             'not working white screen',
    expectIntentId:   'white_screen_refresh',
    expectEscalation: false,
  },
  {
    label:            'known intent escalation:true — escalates',
    text:             'no inbound calls since 5am multiple agents',
    expectIntentId:   'inbound_missing',
    expectEscalation: true,
  },
  {
    label:            'unknown intent + keyword match — keyword escalation fires',
    text:             'outage multiple agents',
    expectIntentId:   null,
    expectEscalation: true,
  },
  {
    label:            'unknown intent, no keyword match — no escalation',
    text:             'hello can you help me',
    expectIntentId:   null,
    expectEscalation: false,
  },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const intent      = classify(c.text);
  const intentId    = intent?.id ?? null;
  const escalation  = shouldEscalate(c.text);
  const intentOk    = intentId === c.expectIntentId;
  const escalOk     = escalation === c.expectEscalation;
  const ok          = intentOk && escalOk;

  console.log(`${ok ? '✓' : '✗'} ${c.label}`);
  if (!intentOk)  console.log(`    intent:     got=${intentId ?? 'null'} want=${c.expectIntentId ?? 'null'}`);
  if (!escalOk)   console.log(`    escalation: got=${escalation}  want=${c.expectEscalation}`);
  ok ? passed++ : failed++;
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
