// Interrupts: the decisions only Henri can make. Each becomes a decisions row
// and a Telegram message with inline buttons (callback data d:<decisionId>:<optionKey>).
import { json, q1 } from '../../db/client.js';
import type { DecisionRow } from '../../db/repo.js';
import { now } from '../../demo/clock.js';
import { notifyOwner } from '../../telegram/notify.js';
import { decisionButton } from '../../telegram/templates.js';

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
