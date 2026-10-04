// pnpm --filter @lowball/api exec tsx src/demo/mcp-probe.ts
// Connects to the Lowball MCP server the way another agent would, lists its tools and calls get_status.
import { MCPClient } from '@mastra/mcp';
import { env } from '../env.js';

const base = process.env.LOWBALL_API_URL || `http://localhost:${env.PORT}`;
const client = new MCPClient({
  servers: {
    lowball: { url: new URL(`${base}/api/mcp/lowball/mcp`), requestInit: { headers: { authorization: `Bearer ${env.API_TOKEN}` } } },
  },
});
try {
  const tools = await client.listTools();
  console.log('tools:', Object.keys(tools).join(', '));
  const key = Object.keys(tools).find((k) => /get_?status/i.test(k));
  if (!key) throw new Error('get_status is not exposed');
  const out = await (tools[key] as any).execute({}, {});
  console.log('get_status ->', JSON.stringify(out).slice(0, 400));
} finally {
  await client.disconnect();
}
