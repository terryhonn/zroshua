import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { HaService } from '../ha/ha.service';
import { env } from '../env';

export type NotifyEvent =
  | 'run_start'
  | 'run_end'
  | 'skip'
  | 'stop_rain'
  | 'fault'
  | 'system'
  | 'digest';

export type EmitResult = { sent: number; attempted: number };

/**
 * Event router with pluggable providers. Telegram and HA notify ship first;
 * new providers only need a case in deliver().
 */
@Injectable()
export class NotifyService {
  private readonly log = new Logger('Notify');

  constructor(
    private readonly config: ConfigService,
    private readonly ha: HaService,
  ) {}

  async emit(event: NotifyEvent, message: string): Promise<EmitResult> {
    const settings = await this.config.getSettings();
    // Quiet hours suppress realtime chatter. Faults and the scheduled daily
    // digest always go through — the digest toggle is the gate, not the clock.
    const quiet = settings.notifications.quiet;
    if (quiet?.enabled && event !== 'fault' && event !== 'digest') {
      const hhmm = new Date().toTimeString().slice(0, 5);
      const from = (quiet.from ?? '').slice(0, 5);
      const to = (quiet.to ?? '').slice(0, 5);
      const inWindow = from <= to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
      if (inWindow) return { sent: 0, attempted: 0 };
    }
    let sent = 0;
    let attempted = 0;
    for (const provider of settings.notifications.providers) {
      // Digest is opted in via Settings → Daily digest, not the per-provider
      // event list (users pick run_start/fault and never think to include
      // "system", which is what the digest used to ship as).
      if (event !== 'digest' && provider.events.length && !provider.events.includes(event)) continue;
      attempted++;
      try {
        await this.deliver(provider, message);
        sent++;
      } catch (e: any) {
        this.log.warn(`Provider ${provider.type} failed: ${e.message}`);
      }
    }
    return { sent, attempted };
  }

  private async deliver(provider: any, message: string) {
    switch (provider.type) {
      case 'telegram': {
        if (!env.telegramToken) throw new Error('telegram_bot_token is not configured in add-on options');
        const chatIds = provider.chatIds ?? [];
        if (!chatIds.length) throw new Error('no telegram chat IDs configured');
        for (const chatId of chatIds) {
          const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message }),
          });
          if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
        }
        break;
      }
      case 'ha_notify': {
        const [domain, service] = parseNotifyService(provider.service);
        await this.ha.callService(domain, service, undefined, { message });
        break;
      }
      default:
        throw new Error(`unknown provider ${provider.type}`);
    }
  }

  /** Fire one HA notify service with a short ping — ignores event filters and quiet hours. */
  async testHa(service: string): Promise<void> {
    await this.deliver(
      { type: 'ha_notify', service, events: [] },
      '🧪 Zroshua test: Home Assistant notify is working.',
    );
  }
}

/** `notify.mobile_app_phone` or a bare `mobile_app_phone` (domain defaults to notify). */
function parseNotifyService(raw: string | undefined): [string, string] {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('notify service is empty');
  if (s.includes('.')) {
    const [domain, name, ...rest] = s.split('.');
    if (!domain || !name || rest.length) throw new Error(`invalid notify service "${s}"`);
    return [domain, name];
  }
  return ['notify', s];
}
