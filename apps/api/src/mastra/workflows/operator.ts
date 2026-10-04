// Free text from Henri (Telegram or the board chat) -> one action -> one confirming line.
import { env } from '../../env.js';
import { operator } from '../agents/operator.js';
import { withTimeout } from '../model.js';
import * as act from './operatorActions.js';

const num = (s: string) => parseFloat(s.replace(/,/g, ''));

/** Commands that must work instantly and without a model. */
async function direct(text: string): Promise<string | undefined> {
  const t = text.trim().replace(/^\//, '');
  let m: RegExpMatchArray | null;
  if (/^(status|how('?s| is) it going\??|what'?s up\??)$/i.test(t)) return act.status();
  if (/^digest$/i.test(t)) return act.digest();
  if (/^(help|\?)$/i.test(t)) return act.HELP;
  if ((m = t.match(/^(?:(?:drop|set|lower|raise|change|move|put)\s+)?(?:the\s+)?floor\s*(?:to|at|=|:)?\s*\$?\s*([\d,.]+)$/i))) return act.setFloor(num(m[1]!));
  if ((m = t.match(/^(?:(?:drop|set|lower|raise|change|move|put)\s+)?(?:the\s+)?(?:ask|price|asking(?:\s+price)?)\s*(?:to|at|=|:)?\s*\$?\s*([\d,.]+)$/i))) return act.setAsk(num(m[1]!));
  if (/^(fast[\s-]?forward|ff|speed up|resume clock)$/i.test(t)) return act.clock('fast_forward');
  if (/^(pause|stop|freeze)\s+(the\s+)?clock$/i.test(t)) return act.clock('pause');
  if (/^pause$/i.test(t)) return act.pause();
  if (/^(relist|resume|unpause)$/i.test(t)) return act.relistItem();
  if ((m = t.match(/^sold(?:\s+(?:for\s+)?\$?\s*([\d,.]+))?$/i))) return act.sold(m[1] ? num(m[1]) : undefined);
  if (/^delete$/i.test(t)) return act.deleteItem();
  if ((m = t.match(/^(?:show\s+)?buyer\s+#?(\d+)$/i))) return act.showBuyer(parseInt(m[1]!, 10));
  if (/^take\s+(the\s+)?best(\s+offer)?$/i.test(t)) return act.takeBestOffer();
  if (/^(post|list)(\s+(it|this))?(\s+(on|to)\s+craigslist)?$/i.test(t) || /^craigslist$/i.test(t)) return act.craigslist();
  if ((m = t.match(/^(?:pickup\s+|meeting\s+)?spot\s*[:=]?\s+(.{3,200})$/i))) return act.setSpot(m[1]!);
  if ((m = t.match(/^(?:pickup\s+)?windows?\s*[:=]?\s+(.{3,200})$/i))) return act.setWindows(m[1]!);
  return undefined;
}

export async function runOperator(text: string): Promise<string> {
  const fast = await direct(text);
  if (fast != null) return fast;
  if (!env.llmConfigured) return `I didn't get that. ${act.HELP}`;
  try {
    const res = await withTimeout(operator.generate(text.slice(0, 500), { maxSteps: 2 }), 25_000, 'operator');
    // The tool's own line is the confirmation; the model's wording is only a fallback.
    const fromTool = (res.toolResults ?? [])
      .map((r: any) => r?.payload?.result?.result ?? r?.result?.result)
      .filter((s: unknown): s is string => typeof s === 'string');
    if (fromTool.length > 0) return fromTool.join('\n');
    return res.text?.trim() || `I didn't get that. ${act.HELP}`;
  } catch (err) {
    console.warn('[operator] model call failed:', (err as Error).message);
    return `I didn't get that. ${act.HELP}`;
  }
}
