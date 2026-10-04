// pnpm demo:seed [--fresh]
// Seeds the room demo: the chair at ask $220, floor $160, a confirmed buyer at $185 (Thursday),
// one buyer in backup and one blocked scam. --fresh seeds only the item, for the rehearsal script.
// The seeded threads run through the real pipeline, so they are exactly what the agent would do.
import { q, q1 } from '../db/client.js';
import { addClock, getUser } from '../db/repo.js';
import { createInbox, getInbox, mailEnabled, SIM_PREFIX } from '../email/agentmail.js';
import { env } from '../env.js';
import { DAY_MS, now } from './clock.js';

export const SEED_TITLE = 'Herman Miller Sayl office chair, 2019';

export interface SeedResult {
  itemId: string;
  inboxId: string;
  inboxAddress: string;
  buyers: number;
}

async function demoInbox(): Promise<{ inboxId: string; email: string }> {
  if (!mailEnabled()) return { inboxId: 'local-demo', email: 'local-demo@sim.lowball' };
  if (env.AGENTMAIL_DEMO_INBOX_ID) return getInbox(env.AGENTMAIL_DEMO_INBOX_ID);
  const inbox = await createInbox('lowball', 'lowball-demo-inbox', 'Lowball').catch(() => createInbox(`lowball-${Math.floor(now().getTime() / 1000) % 100000}`, 'lowball-demo-inbox-2', 'Lowball'));
  console.log(`[seed] created the demo inbox ${inbox.email}. Put AGENTMAIL_DEMO_INBOX_ID=${inbox.inboxId} in .env.`);
  return inbox;
}

export async function seedDemo(opts: { fresh?: boolean } = {}): Promise<SeedResult> {
  const { handleInbound } = await import('../mastra/workflows/handleInbound.js');
  const user = await getUser();
  await q(
    `update users set neighborhood = coalesce(neighborhood, 'Pac Heights'), pickup_windows = coalesce(pickup_windows, 'Tue/Thu 18:00-20:00, Sat 10:00-12:00'),
       payment_methods = coalesce(payment_methods, 'cash or Venmo'), meeting_spot = coalesce(meeting_spot, 'the building lobby') where id = $1`,
    [user.id],
  );

  const inbox = await demoInbox();
  // Earlier seeds step aside so mail to the demo inbox maps to this item.
  const old = await q<{ id: string }>("update items set status = 'deleted' where title = $1 and status in ('listed','pending','paused') returning id", [SEED_TITLE]);
  for (const o of old) await q("update clocks set done_at = $2 where done_at is null and (payload->>'item_id' = $1)", [o.id, now()]);

  const at = now();
  const item = (await q1<{ id: string }>(
    `insert into items (user_id, status, title, description, condition_notes, ask_cents, floor_cents, listed_at, inbox_id, inbox_address, created_at)
     values ('henri', 'listed', $1, $2, $3, 22000, 16000, $4, $5, $6, $4) returning id`,
    [
      SEED_TITLE,
      'Herman Miller Sayl office chair, 2019. Fully adjustable, one arm slightly loose, otherwise excellent. Pickup Pac Heights, weekday evenings. $220.',
      'one arm slightly loose, otherwise excellent',
      at,
      inbox.inboxId,
      inbox.email,
    ],
  ))!;
  await addClock('decay', new Date(at.getTime() + 3 * DAY_MS), { item_id: item.id });

  let buyers = 0;
  if (!opts.fresh) {
    const mail = (from: string, text: string) => handleInbound({ inboxId: inbox.inboxId, messageId: `${SIM_PREFIX}seed-${item.id.slice(0, 8)}-${++buyers}`, from, subject: SEED_TITLE, text });
    await mail('Maya Okafor <maya@sim.lowball>', 'Hi, is the Sayl still available? I can do $185 and pick it up Thursday at 7.');
    // The seeded pickup stays put: without its clocks the demo clock has nothing to fast-forward to.
    await q("update clocks set done_at = $2 where done_at is null and payload->>'item_id' = $1 and kind <> 'decay'", [item.id, now()]);
    await mail('Jordan Lee <jordan@sim.lowball>', 'Would you take $180? I am free Saturday morning.');
    await mail('Robert K <robert@sim.lowball>', "I'll pay full price, my mover will pick it up, I'll send a cashier's check");
    // The seeded pickup stays put: without its clocks the demo clock has nothing to fast-forward to.
    await q("update clocks set done_at = $2 where done_at is null and payload->>'item_id' = $1 and kind <> 'decay'", [item.id, now()]);
  }
  return { itemId: item.id, inboxId: inbox.inboxId, inboxAddress: inbox.email, buyers };
}

// CLI: ask the running API to seed (it owns the clock and, without Neon, the database).
if (import.meta.url === `file://${process.argv[1]}`) {
  const fresh = process.argv.includes('--fresh');
  const base = process.env.LOWBALL_API_URL || `http://localhost:${env.PORT}`;
  try {
    const res = await fetch(`${base}/demo/seed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lowball-token': env.API_TOKEN }, body: JSON.stringify({ fresh }) });
    const body = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${body}`);
    const out = JSON.parse(body) as SeedResult;
    console.log(`Seeded "${SEED_TITLE}" (${fresh ? 'fresh, no buyers' : `${out.buyers} seeded buyers`}).`);
    console.log(`Buyers write to: ${out.inboxAddress}`);
    process.exit(0);
  } catch (err) {
    console.error(`Could not seed through the API at ${base}: ${(err as Error).message}`);
    console.error('Start the API first (pnpm dev), with DEMO_MODE=true and LOWBALL_API_TOKEN set.');
    process.exit(1);
  }
}
