// Lowball as a tool for other agents: sell_item, get_status, set_floor over MCP.
// Behind the MCP_SERVER flag. Served at /api/mcp/lowball/mcp (Streamable HTTP), token required.
import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';
import { dollars } from '../policy/pricing.js';
import { notifyOwner } from '../telegram/notify.js';
import { draftItem } from './workflows/listItem.js';
import * as act from './workflows/operatorActions.js';

const sellItem = createTool({
  id: 'sell_item',
  description:
    "Start selling an item on Henri's behalf. Lowball prices it from real sold comparables, drafts the listing and sends Henri a proposal on Telegram. Nothing is posted until Henri taps Post. Once posted, Lowball handles every buyer by email.",
  inputSchema: z.object({
    title: z.string().min(3).max(140).describe('Brand, model and year if known, e.g. "Herman Miller Sayl office chair, 2019"'),
    condition: z.string().max(200).optional().describe('One honest line, including any defect'),
    floor_dollars: z.number().positive().optional().describe('Lowest acceptable price. Computed from comparables when omitted.'),
  }),
  outputSchema: z.object({ result: z.string() }),
  execute: async (input) => {
    const card = await draftItem({ title: input.title, condition: input.condition, floorOverrideCents: input.floor_dollars ? Math.round(input.floor_dollars * 100) : undefined });
    await notifyOwner(card.text, card.buttons);
    return {
      result: card.needsPrice
        ? `Draft created for "${input.title}", but there were too few comparable sales to price it. Henri was asked for a price on Telegram.`
        : `Draft created for "${input.title}". Henri has the proposal on Telegram and it goes live when he taps Post.\n${card.text}`,
    };
  },
});

const getStatus = createTool({
  id: 'get_status',
  description: 'Status of the item Lowball is currently selling: price, floor, buyers, best offer, pickup.',
  inputSchema: z.object({}),
  outputSchema: z.object({ result: z.string() }),
  execute: async () => ({ result: await act.status() }),
});

const setFloor = createTool({
  id: 'set_floor',
  description: 'Set the floor price (the lowest price Lowball may accept) for the current item, in dollars.',
  inputSchema: z.object({ dollars: z.number().positive() }),
  outputSchema: z.object({ result: z.string() }),
  execute: async (input) => {
    const result = await act.setFloor(input.dollars);
    await notifyOwner(`Floor changed over MCP: ${dollars(Math.round(input.dollars * 100))}.`);
    return { result };
  },
});

export const MCP_PATH = '/api/mcp/lowball/mcp';

export const mcpServer = new MCPServer({
  id: 'lowball',
  name: 'Lowball',
  version: '0.1.0',
  tools: { sell_item: sellItem, get_status: getStatus, set_floor: setFloor },
});
