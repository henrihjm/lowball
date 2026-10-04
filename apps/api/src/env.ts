// Loads the repo root .env (if present) and exposes typed config. No secrets in the repo.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch (err) {
    console.warn('[env] could not load .env:', (err as Error).message);
  }
}
if (!process.env.TZ) process.env.TZ = 'America/Los_Angeles';

function str(name: string): string {
  const v = (process.env[name] ?? '').trim();
  return v.startsWith('#') ? '' : v.replace(/\s+#.*$/, '').trim();
}
const flag = (name: string) => /^(1|true|yes|on)$/i.test(str(name));

export const env = {
  get DATABASE_URL() { return str('DATABASE_URL'); },
  /** Gateway base normalised to end in /v1. Empty when not configured. */
  get GATEWAY_URL() {
    let base = str('NEON_AI_GATEWAY_BASE_URL').replace(/\/+$/, '').replace(/\/v1$/, '');
    if (!base) return '';
    if (!/^https?:\/\//.test(base)) base = `https://${base}`;
    return `${base}/v1`;
  },
  get GATEWAY_TOKEN() { return str('NEON_AI_GATEWAY_TOKEN'); },
  get MODEL_TEXT() { return str('MODEL_TEXT') || 'gpt-5-mini'; },
  get MODEL_VISION() { return str('MODEL_VISION') || str('MODEL_TEXT') || 'gpt-5-mini'; },
  get VISION_FALLBACK_PROVIDER_KEY() { return str('VISION_FALLBACK_PROVIDER_KEY'); },
  get AGENTMAIL_API_KEY() { return str('AGENTMAIL_API_KEY'); },
  get AGENTMAIL_WEBHOOK_SECRET() { return str('AGENTMAIL_WEBHOOK_SECRET'); },
  get AGENTMAIL_DEMO_INBOX_ID() { return str('AGENTMAIL_DEMO_INBOX_ID'); },
  get EXA_API_KEY() { return str('EXA_API_KEY'); },
  get KERNEL_API_KEY() { return str('KERNEL_API_KEY'); },
  get TELEGRAM_BOT_TOKEN() { return str('TELEGRAM_BOT_TOKEN'); },
  get TELEGRAM_OWNER_CHAT_ID() { return str('TELEGRAM_OWNER_CHAT_ID'); },
  get PUBLIC_BASE_URL() { return str('PUBLIC_BASE_URL').replace(/\/+$/, ''); },
  /** Shared secret between the board's server routes, the demo scripts and this API. */
  get API_TOKEN() { return str('LOWBALL_API_TOKEN'); },
  /** Where the pickup calendar invite goes. */
  get OWNER_EMAIL() { return str('OWNER_EMAIL'); },
  /** Autonomous: no Telegram decisions before the pickup. Henri's flow is photo in, calendar invite out. */
  get AUTONOMOUS() { return !/^(0|false|no|off)$/i.test(str('AUTONOMOUS')); },
  get DEMO_MODE() { return flag('DEMO_MODE'); },
  get DEMO_CLOCK() { return (str('DEMO_CLOCK') || 'auto') as 'auto' | 'always' | 'off'; },
  get KERNEL_POSTING() { return flag('KERNEL_POSTING'); },
  get MCP_SERVER() { return flag('MCP_SERVER'); },
  get PORT() { return parseInt(str('PORT') || '8787', 10); },
  get llmConfigured() { return Boolean(this.GATEWAY_URL && this.GATEWAY_TOKEN); },
};
