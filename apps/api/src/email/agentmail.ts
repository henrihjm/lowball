// AgentMail: the agent's inbox. One thread per buyer, replies go out in-thread.
import { AgentMailClient } from 'agentmail';
import { Webhook } from 'svix';
import { env } from '../env.js';

export interface SentMail {
  inboxId: string;
  inReplyTo?: string;
  to?: string;
  subject?: string;
  text: string;
  messageId?: string;
}

export interface MailTransport {
  reply(inboxId: string, messageId: string, text: string): Promise<{ messageId?: string }>;
  send(inboxId: string, to: string, subject: string, text: string): Promise<{ messageId?: string }>;
}

let client: AgentMailClient | undefined;
function am(): AgentMailClient {
  if (!env.AGENTMAIL_API_KEY) throw new Error('AGENTMAIL_API_KEY is not set');
  client ??= new AgentMailClient({ apiKey: env.AGENTMAIL_API_KEY });
  return client;
}

/** Everything sent this process lifetime. In dry-run mode (no API key) this is the only place mail goes. */
export const outbox: SentMail[] = [];
const remember = (m: SentMail) => {
  outbox.push(m);
  if (outbox.length > 500) outbox.shift();
};

const live: MailTransport = {
  async reply(inboxId, messageId, text) {
    const res = await am().inboxes.messages.reply(inboxId, messageId, { text });
    return { messageId: res.messageId };
  },
  async send(inboxId, to, subject, text) {
    const res = await am().inboxes.messages.send(inboxId, { to, subject, text });
    return { messageId: res.messageId };
  },
};

const dryRun: MailTransport = {
  async reply(_inboxId, messageId, text) {
    console.log(`[mail:dry-run] reply to ${messageId}: ${text}`);
    return {};
  },
  async send(_inboxId, to, subject, text) {
    console.log(`[mail:dry-run] send to ${to} (${subject}): ${text}`);
    return {};
  },
};

let override: MailTransport | undefined;
export const setMailTransport = (t: MailTransport | undefined) => {
  override = t;
};
const transport = (): MailTransport => override ?? (env.AGENTMAIL_API_KEY ? live : dryRun);
/** Simulated buyers (seed, flood test) never produce real mail. */
export const SIM_PREFIX = 'sim:';
export const isSimulated = (messageId?: string | null, to?: string | null) =>
  Boolean(messageId?.startsWith(SIM_PREFIX)) || /@(?:sim\.lowball|example\.(?:com|org|net))$/i.test(to ?? '');
export const mailEnabled = () => Boolean(env.AGENTMAIL_API_KEY);

export interface ThreadRef {
  inboxId: string;
  /** The buyer's last inbound message id. Replying to it keeps the thread. */
  lastInboundMessageId?: string | null;
  to: string;
  subject?: string | null;
}

/**
 * Reply in the buyer's thread. Uses the reply endpoint so threading headers are set.
 * If that fails, falls back to a plain send with a "Re:" subject (the board keys by sender anyway).
 */
export async function replyInThread(ref: ThreadRef, text: string): Promise<{ messageId?: string }> {
  const subject = ref.subject ? (/^re:/i.test(ref.subject) ? ref.subject : `Re: ${ref.subject}`) : 'Re: your message';
  let res: { messageId?: string } | undefined;
  if (!override && isSimulated(ref.lastInboundMessageId, ref.to)) {
    res = await dryRun.send(ref.inboxId, ref.to, subject, text);
  } else if (ref.lastInboundMessageId) {
    try {
      res = await transport().reply(ref.inboxId, ref.lastInboundMessageId, text);
    } catch (err) {
      console.warn('[mail] reply endpoint failed, falling back to send:', (err as Error).message);
    }
  }
  res ??= await transport().send(ref.inboxId, ref.to, subject, text);
  remember({ inboxId: ref.inboxId, inReplyTo: ref.lastInboundMessageId ?? undefined, to: ref.to, subject, text, messageId: res.messageId });
  return res;
}

export async function createInbox(username: string, clientId: string, displayName?: string): Promise<{ inboxId: string; email: string }> {
  const inbox = await am().inboxes.create({ username, clientId, displayName });
  return { inboxId: inbox.inboxId, email: inbox.email };
}

export async function getInbox(inboxId: string): Promise<{ inboxId: string; email: string }> {
  const inbox = await am().inboxes.get(inboxId);
  return { inboxId: inbox.inboxId, email: inbox.email };
}

export interface ReceivedMail {
  inboxId: string;
  threadId: string;
  messageId: string;
  from: string;
  subject?: string;
  timestamp: Date;
}

/** Recent received mail in an inbox, newest first. Used by the poller that backs up the webhook. */
export async function listReceived(inboxId: string, limit = 25): Promise<ReceivedMail[]> {
  const res = await am().inboxes.messages.list(inboxId, { limit, labels: ['received'] });
  return res.messages.map((m) => ({ inboxId: m.inboxId, threadId: m.threadId, messageId: m.messageId, from: m.from, subject: m.subject, timestamp: new Date(m.timestamp) }));
}

export async function getMessageBody(inboxId: string, messageId: string): Promise<{ text?: string; html?: string; extractedText?: string }> {
  const m = await am().inboxes.messages.get(inboxId, messageId);
  return { text: m.text, html: m.html, extractedText: m.extractedText };
}

let webhookSecret = '';

/** Registers the message.received webhook for this deployment (idempotent) and keeps its signing secret. */
export async function ensureWebhook(baseUrl: string): Promise<string> {
  const url = `${baseUrl}/webhooks/agentmail`;
  const existing = await am().webhooks.list();
  const found = existing.webhooks?.find((w) => w.url === url);
  // The list does not carry the signing secret; fetch the endpoint itself for it.
  const hook = found ? await am().webhooks.get(found.webhookId) : await am().webhooks.create({ url, eventTypes: ['message.received'] });
  webhookSecret = hook.secret ?? '';
  if (!webhookSecret) throw new Error(`webhook ${hook.webhookId} returned no signing secret`);
  return hook.webhookId;
}

/**
 * Verifies the Svix signature on the raw body and returns the parsed event.
 * With no secret known (local dry run only) the body is parsed unverified.
 */
export function verifyWebhook(rawBody: string, headers: Record<string, string>): any {
  const secret = env.AGENTMAIL_WEBHOOK_SECRET || webhookSecret;
  if (!secret) {
    // Unsigned events are only accepted when no real mail can be sent in response.
    if (mailEnabled()) throw new Error('webhook secret unknown; refusing unsigned webhook');
    return JSON.parse(rawBody);
  }
  return new Webhook(secret).verify(rawBody, headers);
}

export const hasWebhookSecret = () => Boolean(env.AGENTMAIL_WEBHOOK_SECRET || webhookSecret);
