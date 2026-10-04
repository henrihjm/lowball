import { now } from '../demo/clock.js';

// A thin seam between the workflows and the Telegram bot, so workflows can
// message Henri without importing grammY (and tests can capture what is sent).
export interface Button {
  text: string;
  data: string;
}

export interface OwnerMessage {
  text: string;
  buttons?: Button[];
}

type Notifier = (msg: OwnerMessage) => Promise<void>;

/** Everything sent to Henri this process lifetime, newest last. The board shows the tail. */
export const sentToOwner: (OwnerMessage & { at: string })[] = [];

let notifier: Notifier | undefined;
export const setNotifier = (n: Notifier | undefined) => {
  notifier = n;
};

export async function notifyOwner(text: string, buttons?: Button[]): Promise<void> {
  sentToOwner.push({ text, buttons, at: now().toISOString() });
  if (sentToOwner.length > 200) sentToOwner.shift();
  if (!notifier) {
    console.log(`[telegram:not-connected] ${text}${buttons ? ' ' + buttons.map((b) => `[${b.text}]`).join(' ') : ''}`);
    return;
  }
  try {
    await notifier({ text, buttons });
  } catch (err) {
    console.error('[telegram] send failed:', (err as Error).message);
  }
}
