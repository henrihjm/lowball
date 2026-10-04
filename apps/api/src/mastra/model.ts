// Every LLM call goes through the Neon AI Gateway (OpenAI-compatible endpoint).
import type { Agent } from '@mastra/core/agent';
import type { z } from 'zod';
import { env } from '../env.js';

export function gatewayModel(kind: 'text' | 'vision' = 'text') {
  return {
    providerId: 'neon',
    modelId: kind === 'vision' ? env.MODEL_VISION : env.MODEL_TEXT,
    url: env.GATEWAY_URL,
    apiKey: env.GATEWAY_TOKEN,
  };
}

export const LLM_TIMEOUT_MS = 20_000;

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Pulls the first JSON object or array out of model text. */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error('no JSON in model output');
  }
}

/**
 * Ask an agent for JSON and validate it with zod. Returns undefined when the gateway
 * is not configured, times out, or the output does not validate. Callers always have
 * a rule-based fallback, so a model failure never blocks a reply.
 */
export async function generateJson<T>(agent: Agent<any, any>, messages: any, schema: z.ZodType<T>, label: string, timeoutMs = LLM_TIMEOUT_MS): Promise<T | undefined> {
  if (!env.llmConfigured) return undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withTimeout(agent.generate(messages, { maxSteps: 1, toolChoice: 'none' }), timeoutMs, label);
      const parsed = schema.safeParse(parseJsonLoose(res.text ?? ''));
      if (parsed.success) return parsed.data;
      console.warn(`[llm] ${label}: output failed validation:`, parsed.error.issues.slice(0, 2));
    } catch (err) {
      console.warn(`[llm] ${label} failed:`, (err as Error).message);
    }
  }
  return undefined;
}
