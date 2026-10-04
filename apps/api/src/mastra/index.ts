// Mastra instance: agents, tools, workflows, tracing, MCP server.
// `mastra dev --dir src/mastra` (pnpm studio) opens Mastra Studio on the same agents and traces.
import { Mastra } from '@mastra/core';
import { DefaultExporter, Observability } from '@mastra/observability';
import { PostgresStore } from '@mastra/pg';
import { classifier } from '../email/classify.js';
import { env } from '../env.js';
import { identifier } from './agents/identifier.js';
import { negotiator } from './agents/negotiator.js';
import { operator } from './agents/operator.js';
import { pricer } from './agents/pricer.js';
import { mcpServer } from './mcp.js';
import { inboundWorkflow } from './workflows/handleInbound.js';

// Traces go to the same Neon database as the app, in their own schema.
// One trace per agent call: the judgment behind each buyer reply can be opened and read.
function tracing() {
  if (!env.DATABASE_URL) return {};
  try {
    return {
      storage: new PostgresStore({ id: 'lowball-mastra', connectionString: env.DATABASE_URL, schemaName: 'mastra' }),
      observability: new Observability({ configs: { default: { serviceName: 'lowball', exporters: [new DefaultExporter()] } } }),
    };
  } catch (err) {
    console.warn('[mastra] tracing is off:', (err as Error).message);
    return {};
  }
}

export const mastra = new Mastra({
  agents: { identifier, pricer, negotiator, operator, classifier },
  workflows: { handleInbound: inboundWorkflow },
  mcpServers: { lowball: mcpServer },
  ...tracing(),
});
