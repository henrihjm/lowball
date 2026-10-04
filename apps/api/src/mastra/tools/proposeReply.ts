// proposeReply: the negotiator's output channel. A proposal is not sent until
// code has validated every dollar amount in it against the floor.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export interface Proposal {
  reply: string;
  reasoning: string;
}

const proposals = new Map<string, Proposal>();

export function takeProposal(buyerId: string): Proposal | undefined {
  const p = proposals.get(buyerId);
  proposals.delete(buyerId);
  return p;
}

export const proposeReply = createTool({
  id: 'proposeReply',
  description: 'Propose the email reply to the buyer, with a one-line reasoning. Code validates it before anything is sent.',
  inputSchema: z.object({
    buyer_id: z.string(),
    reply: z.string().describe('The email body to send to the buyer. Plain text, 1 to 4 short sentences.'),
    reasoning: z.string().describe('One line: why this reply. Shown on the operator board. Never sent to the buyer.'),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => {
    proposals.set(input.buyer_id, { reply: input.reply, reasoning: input.reasoning });
    return { ok: true };
  },
});
