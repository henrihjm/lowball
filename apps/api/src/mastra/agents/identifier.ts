// The identifier turns photos (and Henri's caption) into an item: name, condition, notes.
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { env } from '../../env.js';
import { gatewayModel, LLM_TIMEOUT_MS, parseJsonLoose, withTimeout } from '../model.js';

const INSTRUCTIONS = `You identify a second-hand item from photos so it can be listed for sale.
The seller's caption, if any, is authoritative for defects and details.
Reply with only JSON:
{"title": string,        // brand, model, year if known, e.g. "Herman Miller Sayl office chair, 2019". If the brand is unknown, a plain accurate name.
 "condition": string,    // one short honest line, including any defect from the caption, e.g. "one arm slightly loose, otherwise excellent"
 "notes": string,        // one or two factual sentences for the listing body: what it is and what is included. No hype. No emojis.
 "search_query": string, // brand and model only, for finding sold prices
 "confident": boolean}   // false if you cannot tell what the item is`;

export const identifier = new Agent({
  id: 'identifier',
  name: 'Identifier',
  instructions: INSTRUCTIONS,
  model: () => gatewayModel('vision'),
});

const schema = z.object({
  title: z.string().min(2),
  condition: z.string(),
  notes: z.string(),
  search_query: z.string(),
  confident: z.boolean().optional(),
});
export type Identification = z.infer<typeof schema>;

export interface Photo {
  base64: string;
  mime: string;
}

/** Plain OpenAI-style chat completion with image parts, against the gateway or a direct provider key. */
async function rawVision(url: string, key: string, model: string, text: string, photos: Photo[]): Promise<string> {
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: [{ type: 'text', text }, ...photos.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } }))] },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS + 10_000),
  });
  if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : '';
}

/**
 * The single vision call. Order: the Mastra agent through the gateway, then a raw
 * gateway call, then (only if the gateway cannot take images) a direct provider key.
 */
export async function identify(photos: Photo[], caption?: string | null): Promise<Identification | undefined> {
  const text = `Seller's caption: ${caption?.trim() ? JSON.stringify(caption.trim()) : '(none)'}`;
  const attempts: [string, () => Promise<string>][] = [];
  if (env.llmConfigured) {
    attempts.push([
      'mastra',
      async () => {
        const res = await withTimeout(
          identifier.generate(
            [{ role: 'user', content: [{ type: 'text', text }, ...photos.slice(0, 3).map((p) => ({ type: 'image' as const, image: `data:${p.mime};base64,${p.base64}`, mimeType: p.mime }))] }] as any,
            { maxSteps: 1 },
          ),
          LLM_TIMEOUT_MS + 10_000,
          'identify',
        );
        return res.text ?? '';
      },
    ]);
    attempts.push(['gateway', () => rawVision(env.GATEWAY_URL, env.GATEWAY_TOKEN, env.MODEL_VISION, text, photos.slice(0, 3))]);
  }
  if (env.VISION_FALLBACK_PROVIDER_KEY) {
    attempts.push(['direct', () => rawVision('https://api.openai.com/v1', env.VISION_FALLBACK_PROVIDER_KEY, env.MODEL_VISION, text, photos.slice(0, 3))]);
  }
  for (const [label, run] of attempts) {
    try {
      const parsed = schema.safeParse(parseJsonLoose(await run()));
      if (parsed.success) return parsed.data;
      console.warn(`[identify] ${label}: output failed validation`);
    } catch (err) {
      console.warn(`[identify] ${label} failed:`, (err as Error).message);
    }
  }
  return undefined;
}
