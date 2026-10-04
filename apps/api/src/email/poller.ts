// Backup for the webhook: every few seconds, look for received mail the webhook did not deliver.
// Both paths end in the same queue, and the message id dedupe makes a double delivery harmless.
import { q } from '../db/client.js';
import { realNowMs } from '../demo/clock.js';
import { enqueueInbound } from '../mastra/workflows/handleInbound.js';
import { getMessageBody, listReceived, mailEnabled } from './agentmail.js';

const POLL_MS = 3_000;
/** Mail older than this when first seen is history, not a buyer waiting for an answer. */
const MAX_AGE_MS = 10 * 60_000;

const seen = new Set<string>();
let busy = false;
let lastError = '';

async function pollOnce(): Promise<void> {
  const inboxes = await q<{ inbox_id: string }>(
    "select distinct inbox_id from items where status in ('listed','pending') and inbox_id is not null and inbox_address not like '%@sim.lowball'",
  );
  for (const { inbox_id } of inboxes) {
    const fresh = (await listReceived(inbox_id)).filter((m) => !seen.has(m.messageId));
    if (fresh.length === 0) continue;
    const known = new Set(
      (await q<{ agentmail_message_id: string }>('select agentmail_message_id from messages where agentmail_message_id = any($1::text[])', [fresh.map((m) => m.messageId)])).map(
        (r) => r.agentmail_message_id,
      ),
    );
    // Oldest first, so a buyer's messages are answered in the order they were written.
    for (const m of fresh.reverse()) {
      seen.add(m.messageId);
      if (known.has(m.messageId) || realNowMs() - m.timestamp.getTime() > MAX_AGE_MS) continue;
      const body = await getMessageBody(m.inboxId, m.messageId);
      console.log(`[poller] picked up ${m.messageId} from ${m.from}`);
      enqueueInbound({ inboxId: m.inboxId, threadId: m.threadId, messageId: m.messageId, from: m.from, subject: m.subject, ...body });
    }
  }
}

export function startMailPoller(): NodeJS.Timeout | undefined {
  if (!mailEnabled()) return undefined;
  console.log(`[poller] checking live inboxes every ${POLL_MS / 1000}s as a backup for the webhook`);
  return setInterval(() => {
    if (busy) return;
    busy = true;
    pollOnce()
      .then(() => (lastError = ''))
      .catch((err) => {
        const msg = (err as Error).message;
        if (msg !== lastError) console.warn('[poller] failed:', msg);
        lastError = msg;
      })
      .finally(() => (busy = false));
  }, POLL_MS);
}
