import { NextResponse, type NextRequest } from 'next/server';
import { mockState } from '@/lib/mock';
import { NO_STORE, apiFetch, isUuid, mockMode } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (mockMode() || params.get('mock') === '1') return NextResponse.json(mockState(), { headers: NO_STORE });

  const item = params.get('item');
  const query = item && isUuid(item) ? `?item=${item}` : '';
  try {
    const res = await apiFetch(`/api/state${query}`);
    if (!res.ok) {
      const error = res.status === 401 ? 'unauthorized' : 'api_error';
      return NextResponse.json({ error, status: res.status }, { status: 502, headers: NO_STORE });
    }
    return NextResponse.json(await res.json(), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: 'api_unreachable' }, { status: 503, headers: NO_STORE });
  }
}
