import * as fs   from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Schema types (mirror config/intents.yml)
// ---------------------------------------------------------------------------
interface IntentDef {
  id:             string;
  priority:       number;
  patterns:       string[];
  reply_template: string;
  escalation?:    boolean;
}

interface IntentsFile {
  intents: IntentDef[];
}

interface CompiledIntent {
  id:            string;
  priority:      number;
  regexes:       RegExp[];
  replyTemplate: string;
  escalation:    boolean;
}

// ---------------------------------------------------------------------------
// Public result type returned by classify()
// ---------------------------------------------------------------------------
export interface ClassifyResult {
  id:            string;
  replyTemplate: string;
  escalation:    boolean;
}

// ---------------------------------------------------------------------------
// English-only fallback for unrecognised issues
// ---------------------------------------------------------------------------
export const FALLBACK_REPLY = [
  'We were unable to identify the specific issue automatically.',
  'Please reply with the details below (copy/paste and fill in):',
  '',
  '- Browser + version:',
  '  (Example: "Chrome 122.0", "Edge 121", "Firefox 123". You can find it in Menu → Help → About.)',
  '',
  '- Incognito tried: Y / N',
  '  (Did you try opening Flex/Twilio in an Incognito/Private window to rule out cache/session issues?)',
  '',
  '- Extensions disabled: Y / N',
  '  (Did you try disabling browser extensions like adblockers, security tools, password managers, etc., or testing in a clean browser profile?)',
  '',
  '- Error text or screenshot:',
  '  (Paste the exact error message if you see one, or attach a screenshot. If it\'s just a blank/white screen, say "white screen" and when it happens.)',
  '',
  '- When did it start (time + timezone):',
  '  (Example: "Started 09:10 AM PST" / "Started 14:30 UTC".)',
  '',
  '- How many agents are affected:',
  '  (Example: "Only me" / "3 agents" / "Everyone in the queue".)',
].join('\n');

// ---------------------------------------------------------------------------
// Load + compile intents from config/intents.yml at module load (startup)
// Throws immediately if the file is missing, malformed, or contains bad regex.
// ---------------------------------------------------------------------------
function load(): CompiledIntent[] {
  const filePath = path.resolve(__dirname, '../config/intents.yml');

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`[intents] Cannot load config/intents.yml: ${err}`);
  }

  const file = raw as IntentsFile;
  if (!Array.isArray(file?.intents)) {
    throw new Error('[intents] config/intents.yml must contain a top-level "intents" array');
  }

  const compiled = file.intents.map((def): CompiledIntent => {
    if (
      typeof def.id            !== 'string' ||
      typeof def.priority      !== 'number' ||
      !Array.isArray(def.patterns)           ||
      typeof def.reply_template !== 'string'
    ) {
      throw new Error(`[intents] Invalid intent entry: ${JSON.stringify(def)}`);
    }

    const regexes = def.patterns.map((p, i) => {
      try {
        return new RegExp(p, 'i');
      } catch (err) {
        throw new Error(
          `[intents] Pattern [${i}] "${p}" in intent "${def.id}" is not a valid regex: ${err}`,
        );
      }
    });

    return {
      id:            def.id,
      priority:      def.priority,
      regexes,
      replyTemplate: def.reply_template.trim(),
      escalation:    def.escalation ?? false,
    };
  });

  return compiled.sort((a, b) => a.priority - b.priority);
}

export const compiledIntents: readonly CompiledIntent[] = load();

console.log(
  `[intents] Loaded ${compiledIntents.length} intent(s): ` +
  compiledIntents.map((i) => `${i.id}(${i.priority})`).join(', '),
);

// ---------------------------------------------------------------------------
// classify — returns the highest-priority matching intent, or null
// ---------------------------------------------------------------------------
export function classify(text: string): ClassifyResult | null {
  for (const intent of compiledIntents) {
    if (intent.regexes.some((re) => re.test(text))) {
      return {
        id:            intent.id,
        replyTemplate: intent.replyTemplate,
        escalation:    intent.escalation,
      };
    }
  }
  return null;
}
