// One Node process: HTTP routes, AgentMail webhook, scheduler loop, Telegram bot.
import { timingSafeEqual } from 'node:crypto';
import { serve, type HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono, type Context, type Next } from 'hono';
import { dbKind } from './db/client.js';
import { currentItem } from './db/repo.js';
import { clockInfo } from './demo/clock.js';
import { ensureWebhook, hasWebhookSecret, mailEnabled, SIM_PREFIX, verifyWebhook } from './email/agentmail.js';
import { startMailPoller } from './email/poller.js';
import { env } from './env.js';
import './mastra/index.js';
import { MCP_PATH, mcpServer } from './mastra/mcp.js';
import { enqueueInbound, handleInbound, queueDepth, type InboundEmail } from './mastra/workflows/handleInbound.js';
import { startScheduler } from './mastra/workflows/scheduler.js';
import { runOperator } from './mastra/workflows/operator.js';
import { operatorRequest } from '@lowball/shared';
import { boardState } from './state.js';
import { itemPhoto, startTelegram, telegramStatus } from './telegram/bot.js';

const app = new Hono<{ Bindings: HttpBindings }>();

function tokenOk(given: string | undefined): boolean {
  const want = env.API_TOKEN;
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** /api and /demo are for the board's server routes and the demo scripts only. */
async function requireToken(c: Context, next: Next) {
  const given = c.req.header('x-lowball-token') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!tokenOk(given)) return c.json({ error: 'unauthorized' }, 401);
  await next();
}

app.get('/health', async (c) =>
  c.json({
    ok: true,
    db: await dbKind(),
    mail: mailEnabled() ? (hasWebhookSecret() ? 'live' : 'live, webhook not verified yet') : 'dry-run',
    llm: env.llmConfigured ? env.MODEL_TEXT : 'not configured (templated replies)',
    telegram: telegramStatus(),
    demoMode: env.DEMO_MODE,
    clock: clockInfo(),
    queue: queueDepth(),
  }),
);

// AgentMail -> message.received. Signature verified on the raw body, then queued.
app.post('/webhooks/agentmail', async (c) => {
  const raw = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  let event: any;
  try {
    event = verifyWebhook(raw, headers);
  } catch (err) {
    console.warn('[webhook] rejected:', (err as Error).message);
    return c.body(null, 400);
  }
  if (event?.event_type === 'message.received' && event.message) {
    const m = event.message;
    const ev: InboundEmail = {
      inboxId: m.inbox_id,
      threadId: m.thread_id,
      messageId: m.message_id,
      from: typeof m.from === 'string' ? m.from : String(m.from_ ?? m.from?.[0] ?? ''),
      subject: m.subject,
      text: m.text,
      html: m.html,
      extractedText: m.extracted_text,
    };
    console.log(`[webhook] message.received ${ev.messageId} from ${ev.from}`);
    enqueueInbound(ev);
  }
  return c.body(null, 204);
});

app.use('/api/*', requireToken);
app.use('/demo/*', requireToken);

app.get('/api/state', async (c) => c.json(await boardState(c.req.query('item') ?? undefined)));

// Operator chat from the board. Same commands as Telegram.
app.post('/api/operator', async (c) => {
  const b = operatorRequest.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: 'text is required' }, 400);
  return c.json({ reply: await runOperator(b.data.text) });
});

app.get('/api/photo/:id', async (c) => {
  const photo = await itemPhoto(c.req.param('id'));
  if (!photo) return c.json({ error: 'no photo' }, 404);
  return c.body(new Uint8Array(photo.bytes), 200, { 'content-type': photo.mime, 'cache-control': 'private, max-age=300' });
});

// Lowball as an MCP server (P2, behind MCP_SERVER). Register this URL in Executor with the bearer token.
app.all(MCP_PATH, async (c) => {
  if (!env.MCP_SERVER) return c.json({ error: 'MCP server is off (MCP_SERVER=false)' }, 404);
  await mcpServer.startHTTP({ url: new URL(c.req.url), httpPath: MCP_PATH, req: c.env.incoming, res: c.env.outgoing });
  return RESPONSE_ALREADY_SENT;
});

// Simulated buyer email (seed and flood test). Goes through the same pipeline; no real mail is sent.
app.post('/demo/inbound', async (c) => {
  if (!env.DEMO_MODE) return c.json({ error: 'demo mode is off' }, 403);
  const b = await c.req.json<{ inboxId?: string; from: string; text: string; subject?: string; messageId?: string }>();
  if (!b?.from || typeof b.text !== 'string') return c.json({ error: 'from and text are required' }, 400);
  const inboxId = b.inboxId ?? (await currentItem())?.inbox_id;
  if (!inboxId) return c.json({ error: 'no live item' }, 409);
  const messageId = `${SIM_PREFIX}${b.messageId ?? crypto.randomUUID()}`;
  const result = await handleInbound({ inboxId, messageId, from: b.from, subject: b.subject ?? 'Chair', text: b.text });
  return c.json(result);
});

app.post('/demo/seed', async (c) => {
  if (!env.DEMO_MODE) return c.json({ error: 'demo mode is off' }, 403);
  const b = await c.req.json<{ fresh?: boolean }>().catch(() => ({}) as { fresh?: boolean });
  const { seedDemo } = await import('./demo/seed.js');
  return c.json(await seedDemo({ fresh: Boolean(b.fresh) }));
});

async function main() {
  console.log(`[boot] db: ${await dbKind()} · llm: ${env.llmConfigured ? env.MODEL_TEXT : 'not configured'} · mail: ${mailEnabled() ? 'AgentMail' : 'dry-run'} · demo: ${env.DEMO_MODE}`);
  if (!env.API_TOKEN) console.warn('[boot] LOWBALL_API_TOKEN is not set. /api and /demo routes will refuse every request.');

  serve({ fetch: app.fetch, port: env.PORT }, (info) => console.log(`[boot] listening on :${info.port}`));

  if (mailEnabled() && env.PUBLIC_BASE_URL) {
    try {
      const id = await ensureWebhook(env.PUBLIC_BASE_URL);
      console.log(`[boot] AgentMail webhook ${id} -> ${env.PUBLIC_BASE_URL}/webhooks/agentmail`);
    } catch (err) {
      console.error('[boot] could not register the AgentMail webhook:', (err as Error).message);
    }
  } else if (mailEnabled()) {
    console.warn('[boot] PUBLIC_BASE_URL is not set. AgentMail cannot reach this server until it is.');
  }

  await startScheduler();
  startMailPoller();
  await startTelegram().catch((err) => console.error('[boot] Telegram did not start:', (err as Error).message));
}

// A failed background call (a model, a mail send) must never take the whole agent down mid-demo.
process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection:', err));

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});

export { app };
