import { proto } from '@whiskeysockets/baileys';

// The bot's own ids. WhatsApp names the same account two ways: a phone JID
// (2348012345678:12@s.whatsapp.net) and, in LID-addressed groups, a LID (123456789:12@lid).
// A tag or a quote can use either, so both are checked.
export interface BotIds {
  jid: string;
  lid: string;
}

// The user part of a JID, without the device suffix or the domain.
export function userPart(jid: string | null | undefined): string {
  return (jid ?? '').split('@')[0].split(':')[0];
}

export function isBotJid(jid: string | null | undefined, bot: BotIds): boolean {
  const user = userPart(jid);
  if (!user) return false;
  return user === userPart(bot.jid) || user === userPart(bot.lid);
}

// The contextInfo of whatever kind of message this is (text, image, document, video,
// sticker...). It holds the tags and the quoted message.
export function findContextInfo(m: proto.IMessage | null | undefined): proto.IContextInfo | null {
  if (!m) return null;
  for (const value of Object.values(m)) {
    if (value && typeof value === 'object' && 'contextInfo' in value) {
      const ctx = (value as { contextInfo?: proto.IContextInfo | null }).contextInfo;
      if (ctx) return ctx;
    }
  }
  return null;
}

export interface Addressing {
  // Lady Bachs is @tagged in this message.
  mentioned: boolean;
  // This message quotes one of Lady Bachs' own messages.
  replyToBot: boolean;
}

// Was this message spoken to the bot? A tag, by phone JID or LID, or a reply to one of its
// messages. The text check catches a tag whose mentionedJid list did not come through.
export function addressingOf(
  text: string,
  contextInfo: proto.IContextInfo | null,
  bot: BotIds
): Addressing {
  const mentionedJids = contextInfo?.mentionedJid ?? [];
  const tagTokens = [userPart(bot.jid), userPart(bot.lid)].filter(Boolean).map((u) => `@${u}`);
  const mentioned =
    mentionedJids.some((j) => isBotJid(j, bot)) ||
    tagTokens.some((t) => new RegExp(`${t}(?!\\d)`).test(text));
  const quotes = Boolean(contextInfo?.quotedMessage || contextInfo?.stanzaId);
  const replyToBot = quotes && isBotJid(contextInfo?.participant, bot);
  return { mentioned, replyToBot };
}
