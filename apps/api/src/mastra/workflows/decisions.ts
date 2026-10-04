// Interrupts: the decisions only Henri can make. Each becomes a decisions row
// and a Telegram message with inline buttons (callback data d:<decisionId>:<optionKey>).
import { json, q1 } from '../../db/client.js';
import type { DecisionRow } from '../../db/repo.js';
import { now } from '../../demo/clock.js';
import { env } from '../../env.js';
import { notifyOwner } from '../../telegram/notify.js';
import { decisionButton } from '../../telegram/templates.js';

/** What Lowball does on its own: hold the floor, keep to the pickup windows, block what looks like a scam, wait for a late buyer. */
const AUTO_CHOICE: Partial<Record<DecisionRow['kind'], string>> = {
  below_floor: 'hold_floor',
  slot_conflict: 'decline',
  scam_unsure: 'block',
  noshow: 'wait',
};

export interface NewDecision {
  kind: DecisionRow['kind'];
  itemId: string;
  buyerId?: string | null;
  payload: Record<string, any>;
  options: { key: string; label: string }[];
  text: string;
  /** Skip if an unresolved decision of this kind already exists for the buyer (or item, when no buyer). */
  dedupe?: boolean;
}

export async function createDecision(d: NewDecision): Promise<string | undefined> {
  // Autonomous mode: before the pickup, Henri is not asked. The safe default is taken and logged.
  const auto = env.AUTONOMOUS ? AUTO_CHOICE[d.kind] : undefined;
  if (auto) {
    const row = (await q1<{ id: string }>(
      'insert into decisions (item_id, buyer_id, kind, payload, options, created_at) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6) returning id',
      [d.itemId, d.buyerId ?? null, d.kind, json({ ...d.payload, auto: true }), json(d.options), now()],
    ))!;
    const { resolveDecision } = await import('./resolve.js');
    // Deferred: the reply that triggered this decision goes out first.
    setTimeout(() => void resolveDecision(row.id, auto).catch((err) => console.error('[decision] auto-resolve failed:', err)), 1500);
    return row.id;
  }
  if (d.dedupe !== false) {
    const open = await q1<{ id: string }>(
      `select id from decisions where kind = $1 and item_id = $2 and resolved_at is null and (buyer_id = $3 or ($3::uuid is null and buyer_id is null)) limit 1`,
      [d.kind, d.itemId, d.buyerId ?? null],
    );
    if (open) return undefined;
  }
  const row = (await q1<{ id: string }>(
    'insert into decisions (item_id, buyer_id, kind, payload, options, created_at) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6) returning id',
    [d.itemId, d.buyerId ?? null, d.kind, json(d.payload), json(d.options), now()],
  ))!;
  await notifyOwner(d.text, d.options.map((o) => decisionButton(row.id, o.key, o.label)));
  return row.id;
}
