// Pickup windows. Typed windows are enough: "Tue/Thu 18:00-20:00, Sat 10:00-12:00".
// Pure functions. Dates are local time (TZ env, America/Los_Angeles).

export interface Window {
  day: number; // 0 = Sunday
  startMin: number;
  endMin: number;
}

const DAY_INDEX: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function expandDays(spec: string): number[] {
  const s = spec.toLowerCase().trim();
  if (/\b(?:every\s*day|daily|any\s*day|all\s+week)\b/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  if (/\bweekdays?\b/.test(s)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(s)) return [0, 6];
  const days: number[] = [];
  for (const part of s.split(/[/,&+]|\band\b/)) {
    const range = part.trim().match(/^([a-z]+)\s*(?:-|to|through|thru)\s*([a-z]+)$/);
    if (range && DAY_INDEX[range[1]!] != null && DAY_INDEX[range[2]!] != null) {
      let d = DAY_INDEX[range[1]!]!;
      const end = DAY_INDEX[range[2]!]!;
      for (let i = 0; i < 7; i++) {
        days.push(d);
        if (d === end) break;
        d = (d + 1) % 7;
      }
      continue;
    }
    const d = DAY_INDEX[part.trim()];
    if (d != null) days.push(d);
  }
  return [...new Set(days)];
}

function parseClock(h: string, m: string | undefined, mer: string | undefined): number {
  let hour = parseInt(h, 10);
  const min = m ? parseInt(m, 10) : 0;
  if (mer) {
    const pm = mer.toLowerCase().startsWith('p');
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  return hour * 60 + min;
}

/** Parses the canonical windows text. Unparseable segments are skipped. */
export function parseWindows(text: string | null | undefined): Window[] {
  if (!text) return [];
  const out: Window[] = [];
  const re = /([A-Za-z][A-Za-z/&,\s-]*?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  for (const m of text.matchAll(re)) {
    const days = expandDays(m[1]!);
    let start = parseClock(m[2]!, m[3], m[4]);
    let end = parseClock(m[5]!, m[6], m[7]);
    // "6 to 8" with no meridiem and an evening hint, or a bare end before start.
    const evening = /evening|night|after\s+work/i.test(m[1]!);
    if (!m[4] && !m[7] && (evening || start < 7 * 60) && start < 12 * 60 && end <= 12 * 60) {
      start += 12 * 60;
      end += 12 * 60;
    }
    if (m[7] && !m[4] && /p/i.test(m[7]) && start + 12 * 60 < end) start += 12 * 60;
    if (end <= start) continue;
    for (const day of days) out.push({ day, startMin: start, endMin: end });
  }
  return out;
}

export function isInsideWindows(date: Date, windows: Window[]): boolean {
  const day = date.getDay();
  const min = date.getHours() * 60 + date.getMinutes();
  return windows.some((w) => w.day === day && min >= w.startMin && min < w.endMin);
}

/** The next n window starts after `now` (at least minLeadMin ahead). */
export function upcomingSlots(windows: Window[], now: Date, n = 3, minLeadMin = 150): Date[] {
  const out: Date[] = [];
  const earliest = now.getTime() + minLeadMin * 60_000;
  for (let offset = 0; offset < 15 && out.length < n * 3; offset++) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    for (const w of windows.filter((x) => x.day === base.getDay()).sort((a, b) => a.startMin - b.startMin)) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(w.startMin / 60), w.startMin % 60);
      if (d.getTime() >= earliest) out.push(d);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime()).slice(0, n);
}

function fmtClock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** "Thu 7pm" */
export function formatSlot(d: Date): string {
  return `${DAY_SHORT[d.getDay()]} ${fmtClock(d)}`;
}

/** "Thu Oct 8, 7pm" */
export function formatSlotLong(d: Date): string {
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${DAY_SHORT[d.getDay()]} ${month} ${d.getDate()}, ${fmtClock(d)}`;
}

export interface BuyerTime {
  date: Date;
  insideWindows: boolean;
}

/**
 * A concrete time in buyer text: "Thursday 7", "tomorrow at 6:30pm", "today 5", "Sat 10am".
 * An hour without am/pm resolves to whichever reading falls inside the pickup windows, pm first.
 * Returns undefined when there is no day or no hour.
 */
export function parseBuyerTime(text: string, now: Date, windows: Window[]): BuyerTime | undefined {
  const t = text.toLowerCase();
  const dayRe = /\b(today|tonight|tomorrow|tmrw|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thurs?|thu|fri|sat)\b/;
  const dm = t.match(dayRe);
  if (!dm) return undefined;
  const after = t.slice(dm.index! + dm[0].length);
  const before = t.slice(0, dm.index!);
  const hourRe = /(?:^|[\s,@]|at\s|around\s|by\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)?(?![\d$]|\s*(?:bucks|dollars|cash|usd))/;
  // Prefer the hour right after the day word, within a short distance.
  let hm = after.slice(0, 24).match(hourRe);
  if (!hm) {
    const explicit = before.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)\s*(?:on\s+)?$/);
    if (explicit) hm = explicit;
  }
  if (!hm) return undefined;
  const hour = parseInt(hm[1]!, 10);
  const minute = hm[2] ? parseInt(hm[2], 10) : 0;
  if (hour > 23 || minute > 59 || hour === 0) return undefined;

  let base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const word = dm[0];
  if (word === 'tomorrow' || word === 'tmrw') base = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  else if (word !== 'today' && word !== 'tonight') {
    const target = DAY_INDEX[word]!;
    let delta = (target - base.getDay() + 7) % 7;
    const candidateToday = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour < 12 ? hour + 12 : hour, minute);
    if (delta === 0 && candidateToday.getTime() <= now.getTime()) delta = 7;
    base = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta);
  }

  const mk = (h: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, minute);
  const mer = hm[3];
  let date: Date;
  if (mer) {
    const pm = mer.startsWith('p');
    date = mk(pm ? (hour < 12 ? hour + 12 : hour) : hour === 12 ? 0 : hour);
  } else if (hour >= 13) {
    date = mk(hour);
  } else {
    const pmDate = mk(hour < 12 ? hour + 12 : hour);
    const amDate = mk(hour);
    if (isInsideWindows(pmDate, windows)) date = pmDate;
    else if (isInsideWindows(amDate, windows)) date = amDate;
    else date = word === 'tonight' || hour < 8 ? pmDate : amDate;
  }
  return { date, insideWindows: isInsideWindows(date, windows) };
}
