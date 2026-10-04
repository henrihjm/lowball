const TZ = 'America/Los_Angeles';

export function usd(cents: number | null | undefined): string {
  if (cents == null) return 'n/a';
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fmt = (f: Intl.DateTimeFormat) => (iso: string | null | undefined) => {
  const d = parse(iso);
  return d ? f.format(d) : '';
};

/** "7:00 PM" */
export const fmtTime = fmt(timeFmt);
/** "Thu 7:00 PM" */
export const fmtDayTime = fmt(dayTimeFmt);
/** "Thu, Oct 8" */
export const fmtDay = fmt(dayFmt);

export function countdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Only http(s) URLs are ever put in an href or an iframe src. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const INTENT_LABEL: Record<string, string> = {
  answer: 'answer',
  counter: 'counter',
  counter_final: 'final counter',
  injection: 'injection refused',
  accept_needs_time: 'accept, needs a time',
  slot_confirmed: 'slot confirmed',
  slot_conflict: 'asked Henri',
  match_higher: 'higher offer on the table',
  confirmed_followup: 'follow-up',
  address_gate: 'address gated',
  backup: 'backup',
  schedule: 'scheduling',
  scam: 'scam',
};

export const intentLabel = (intent: string | null | undefined): string | null =>
  intent ? (INTENT_LABEL[intent] ?? intent.replace(/_/g, ' ')) : null;

const STATUS_LABEL: Record<string, string> = { noshow: 'no-show' };
export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;
