// blockBuyer: marks a buyer as a scammer. No further replies go to a blocked buyer.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { json, q } from '../../db/client.js';
import type { ScamMatch } from '../../policy/scam.js';

export async function blockBuyerCore(buyerId: string, flags: ScamMatch[]): Promise<void> {
  await q("update buyers set status = 'blocked', scam_flags = $2::jsonb where id = $1", [buyerId, json(flags)]);
}

export const blockBuyer = createTool({
  id: 'blockBuyer',
  description: 'Block a buyer who is clearly running a payment, shipping or verification-code scam. They get no further replies.',
  inputSchema: z.object({ buyer_id: z.string(), reason: z.string().max(120) }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    await blockBuyerCore(input.buyer_id, [{ rule: 'model_flag', label: input.reason }]);
    return { ok: true };
  },
});
