import { logger } from '../utils/logger';

// The body pm-agent's /webhook reads (bachs-agent interface/bachs_notify.py).
export interface AgentInboundPayload {
  message_id: string;
  thread_key: string;
  sender_id: string;
  sender_name?: string;
  text: string;
  quoted_text?: string;
  quoted_sender?: string;
  timestamp: number;
}

// AGENT_WEBHOOK_URL may be the pm-agent base URL or the full /webhook URL.
export function webhookUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/webhook') ? trimmed : `${trimmed}/webhook`;
}

export async function forwardToAgent(
  url: string,
  key: string,
  payload: AgentInboundPayload
): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      logger.error({ status: res.status, group: payload.thread_key }, 'pm-agent refused forwarded message');
      return false;
    }
    logger.info({ group: payload.thread_key, messageId: payload.message_id }, 'Forwarded to pm-agent');
    return true;
  } catch (err) {
    logger.error({ err, group: payload.thread_key }, 'Failed to forward message to pm-agent');
    return false;
  }
}
