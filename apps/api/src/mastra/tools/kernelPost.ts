// kernelPost: posts the listing on Craigslist through a Kernel cloud browser.
// EXPERIMENTAL and off by default (KERNEL_POSTING=false). See README.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export type KernelPostResult = { ok: true; url?: string } | { ok: false; reason: string };

export async function kernelPostCore(_itemId: string): Promise<KernelPostResult> {
  return { ok: false, reason: 'automated Craigslist posting is not enabled in this build' };
}

export const kernelPost = createTool({
  id: 'kernelPost',
  description: 'Post the item on Craigslist through a Kernel browser. Experimental.',
  inputSchema: z.object({ item_id: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), url: z.string().optional(), reason: z.string().optional() }),
  execute: async (input) => kernelPostCore(input.item_id),
});
