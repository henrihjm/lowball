// pnpm --filter @lowball/api exec tsx src/demo/probe-mail.ts "still available? $80 cash today" [buyer-name]
// A real buyer, end to end: sends an email from a second AgentMail inbox to the live item's inbox
// and waits for the agent's reply to arrive back by mail. Prints the reply and the round-trip time.
import { AgentMailClient } from 'agentmail';
import { env } from '../env.js';
import { realNowMs } from './clock.js';

const text = process.argv[2] ?? 'still available? $80 cash today';
const who = (process.argv[3] ?? 'a').toLowerCase().replace(/[^a-z0-9]/g, '');
const base = process.env.LOWBALL_API_URL || `http://localhost:${env.PORT}`;

const state = (await (await fetch(`${base}/api/state`, { headers: { 'x-lowball-token': env.API_TOKEN } })).json()) as { item?: { inboxAddress: string; title: string } | null };
const to = state.item?.inboxAddress;
if (!to || to.endsWith('@sim.lowball')) {
  console.error('No live item with a real inbox. Run pnpm demo:seed with AGENTMAIL_API_KEY set.');
  process.exit(1);
}

const client = new AgentMailClient({ apiKey: env.AGENTMAIL_API_KEY });
const buyer = await client.inboxes.create({ clientId: `lowball-probe-buyer-${who}`, displayName: `Phone ${who.toUpperCase()}` });
const before = new Set((await client.inboxes.messages.list(buyer.inboxId, { limit: 50 })).messages.map((m) => m.messageId));

const started = realNowMs();
// Reply inside the buyer's existing thread when there is one, the way a mail client would.
const lastReceived = (await client.inboxes.messages.list(buyer.inboxId, { limit: 20 })).messages.find((m) => m.labels?.includes('received'));
if (lastReceived) await client.inboxes.messages.reply(buyer.inboxId, lastReceived.messageId, { text });
else await client.inboxes.messages.send(buyer.inboxId, { to, subject: state.item!.title, text });
console.log(`${buyer.email} -> ${to}: ${text}`);

for (;;) {
  await new Promise((r) => setTimeout(r, 1500));
  const list = await client.inboxes.messages.list(buyer.inboxId, { limit: 20 });
  const fresh = list.messages.find((m) => !before.has(m.messageId) && m.labels?.includes('received'));
  if (fresh) {
    const full = await client.inboxes.messages.get(buyer.inboxId, fresh.messageId);
    const body = (full.extractedText ?? full.text ?? '').trim();
    console.log(`reply after ${((realNowMs() - started) / 1000).toFixed(1)}s: ${body.split('\n').filter((l) => !l.startsWith('>')).join(' ').slice(0, 400)}`);
    process.exit(0);
  }
  if (realNowMs() - started > 75_000) {
    console.log('no reply within 75s');
    process.exit(2);
  }
}
