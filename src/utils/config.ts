import dotenv from 'dotenv';
import { parseGroupList } from '../handlers/routing';

dotenv.config();

export const config = {
  apiKey: process.env.API_KEY || '',
  serviceName: process.env.SERVICE_NAME || 'WhatsApp Notification Service',
  logLevel: process.env.LOG_LEVEL || 'info',
  port: parseInt(process.env.PORT || '3000', 10),
  proxyUrl: process.env.PROXY_URL || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  // pm-agent (the Lady Bachs agent service). Messages it should see are POSTed here.
  agentWebhookUrl: process.env.AGENT_WEBHOOK_URL || '',
  agentWebhookKey: process.env.AGENT_WEBHOOK_KEY || '',
  // Groups pm-agent owns, comma separated. Every message there goes to pm-agent,
  // and the built-in AI never replies there.
  agentGroups: parseGroupList(process.env.AGENT_GROUPS),
  // Set to "false" to stop the built-in AI replying anywhere.
  aiRepliesEnabled: (process.env.LADY_BACHS_ENABLED ?? 'true').toLowerCase() !== 'false'
};

if (!config.apiKey) {
  console.warn('WARNING: API_KEY is not set. All /notify requests will be rejected.');
}

export default config;
