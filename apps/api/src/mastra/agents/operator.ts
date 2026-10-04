// The operator agent maps Henri's free text to actions. Common commands never reach it
// (workflows/operator.ts matches them directly); this handles everything phrased loosely.
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { gatewayModel } from '../model.js';
import * as act from '../workflows/operatorActions.js';

const line = z.object({ result: z.string() });
const tool = <S extends z.ZodType>(id: string, description: string, inputSchema: S, run: (input: z.infer<S>) => Promise<string> | string) =>
  createTool({ id, description, inputSchema, outputSchema: line, execute: async (input) => ({ result: await run(input as z.infer<S>) }) });

const none = z.object({});
const amount = z.object({ dollars: z.number().positive() });

export const operatorTools = {
  status: tool('status', 'Current item, price, buyers, pickup.', none, () => act.status()),
  setFloor: tool('setFloor', 'Set the floor price in dollars.', amount, (i) => act.setFloor(i.dollars)),
  setAsk: tool('setAsk', 'Set the asking price in dollars.', amount, (i) => act.setAsk(i.dollars)),
  pause: tool('pause', 'Pause the listing. Buyers get no replies while paused.', none, () => act.pause()),
  relist: tool('relist', 'Put the item back on the market (after a pause or a pickup that fell through).', none, () => act.relistItem()),
  showBuyer: tool('showBuyer', 'Show buyer number N in the ranking.', z.object({ n: z.number().int().positive() }), (i) => act.showBuyer(i.n)),
  takeBestOffer: tool('takeBestOffer', 'Accept the highest current offer, even below the floor. Only when Henri clearly asks for it.', none, () => act.takeBestOffer()),
  sold: tool('sold', 'Mark the item sold, optionally with the amount in dollars.', z.object({ dollars: z.number().positive().optional() }), (i) => act.sold(i.dollars)),
  deleteItem: tool('deleteItem', 'Delete the listing. Only when Henri clearly asks to delete it.', none, () => act.deleteItem()),
  digest: tool('digest', 'The daily digest line for each listed item.', none, () => act.digest()),
  clock: tool('clock', 'Demo clock: fast forward or pause.', z.object({ action: z.enum(['fast_forward', 'pause']) }), (i) => act.clock(i.action)),
};

export const operator = new Agent({
  id: 'operator',
  name: 'Operator',
  instructions: `You are Lowball's operator interface. Henri, the owner, types short commands about the item he is selling.
Map his message to exactly one tool call. Do not chat. If nothing fits, call no tool and reply with one short line saying what you can do.
After the tool call, reply with the tool's result line, unchanged.
Short sentences. No emojis. No em dashes.`,
  model: () => gatewayModel('text'),
  tools: operatorTools,
});
