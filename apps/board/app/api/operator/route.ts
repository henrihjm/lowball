import { NextResponse, type NextRequest } from 'next/server';
import { NO_STORE, apiFetch, mockMode, readOnly, sameOriginJson } from '@/lib/server';

export const dynamic = 'force-dynamic';

const reply = (text: string, status = 200) => NextResponse.json({ reply: text }, { status, headers: NO_STORE });

/** Henri's free text to the operator agent. Proxies POST /api/operator on apps/api. */
export async function POST(req: NextRequest) {
  if (!sameOriginJson(req)) return reply('Request refused.', 403);
  if (readOnly()) return reply('This board is read-only. Steer the agent from Telegram.', 403);

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  if (!text) return reply('Type a command, for example "status" or "drop floor to 150".', 400);

  if (mockMode() || req.nextUrl.searchParams.get('mock') === '1') {
    return reply('Sample data mode. Start the API (pnpm dev) and reload without ?mock=1 to steer the agent.');
  }

  try {
    const res = await apiFetch('/api/operator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }, 60_000);
    if (res.status === 401) return reply('The API rejected the board token. Check LOWBALL_API_TOKEN in .env.', 502);
    if (res.status === 404) return reply('The API has no operator endpoint yet.', 502);
    const data = (await res.json().catch(() => null)) as { reply?: unknown; error?: unknown } | null;
    if (typeof data?.reply === 'string' && data.reply) return reply(data.reply);
    return reply(typeof data?.error === 'string' ? data.error : `The API answered ${res.status} without a reply.`, 502);
  } catch {
    return reply('Could not reach the Lowball API. Is it running?', 503);
  }
}
