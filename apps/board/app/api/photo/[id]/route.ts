import type { NextRequest } from 'next/server';
import { apiFetch, isUuid } from '@/lib/server';

export const dynamic = 'force-dynamic';

const notFound = () => new Response('Not found', { status: 404 });

/** Item photo, proxied from apps/api so no Telegram file URL or token ever reaches the browser. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  try {
    const res = await apiFetch(`/api/photo/${id}`, {}, 8000);
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return notFound();
    return new Response(res.body, {
      headers: { 'content-type': type, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' },
    });
  } catch {
    return notFound();
  }
}
