export type Route = 'forward' | 'ai' | 'skip';

export interface RouteInput {
  groupJid: string;
  // The bot was @mentioned, or the message quotes one of the bot's messages.
  addressedToBot: boolean;
  agentGroups: string[];
  agentConfigured: boolean;
  aiEnabled: boolean;
}

// Decide who handles a group message: pm-agent, the built-in AI, or nobody.
export function routeMessage(input: RouteInput): Route {
  // pm-agent posts its review questions in its own groups and reads every answer there.
  // The built-in AI must never answer in them, even if pm-agent is not set up,
  // or it replies to a "Yes" meant for pm-agent and pm-agent never sees it.
  if (input.agentGroups.includes(input.groupJid)) {
    return input.agentConfigured ? 'forward' : 'skip';
  }

  if (!input.addressedToBot) return 'skip';
  if (input.aiEnabled) return 'ai';
  return input.agentConfigured ? 'forward' : 'skip';
}

export function parseGroupList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}
