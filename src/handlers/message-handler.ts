import { WAMessage, WASocket, downloadMediaMessage, proto } from '@whiskeysockets/baileys';
import { generateReply } from '../ai/ai';
import { registerContact, resolveNameByNumber } from '../ai/contacts';
import { forwardToAgent } from '../agent/forwarder';
import { AgentMediaFields, loadMedia, pickMedia, unwrapContent } from '../agent/media';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { addressingOf, BotIds, findContextInfo, isBotJid, userPart } from './addressing';
import { routeMessage } from './routing';

// Unwrap all the common message wrapper layers and return the inner IMessage
function unwrapMessage(msg: proto.IWebMessageInfo): proto.IMessage | null {
  return unwrapContent(msg.message);
}

// Extract plain text from any message type that carries text
function extractText(m: proto.IMessage): string {
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

// Detect name introductions for mentioned JIDs
// Handles: "@Chimama is Chimama", "Chimama is @...", "save her as Chimama", "@... is <Name>"
function extractNameFromIntroduction(
  text: string,
  mentionedJids: string[]
): Array<{ name: string; jid: string }> {
  if (mentionedJids.length === 0) return [];

  const results: Array<{ name: string; jid: string }> = [];

  // Pattern: "@mention is <Name>" or "<Name> is @mention"
  const isPattern = /(?:@\d+\s+is\s+([A-Za-z]+)|([A-Za-z]+)\s+is\s+@\d+)/gi;
  // Pattern: "save (her|him|them|this) (as|contact) <Name>" or "her name is <Name>"
  const savePattern = /(?:save\s+(?:her|him|them|this|as)|(?:her|his|their)\s+name\s+is)\s+([A-Za-z]+)/gi;

  let match;
  while ((match = isPattern.exec(text)) !== null) {
    const name = (match[1] || match[2])?.trim();
    if (name && mentionedJids.length > 0) {
      results.push({ name, jid: mentionedJids[0] });
    }
  }

  if (results.length === 0) {
    while ((match = savePattern.exec(text)) !== null) {
      const name = match[1]?.trim();
      if (name && mentionedJids.length > 0) {
        results.push({ name, jid: mentionedJids[0] });
      }
    }
  }

  return results;
}

// Extract mentioned JIDs from any context layer
function extractMentions(m: proto.IMessage): string[] {
  return findContextInfo(m)?.mentionedJid ?? [];
}

export class MessageHandler {
  private sock: WASocket;
  private downloader?: (message: WAMessage) => Promise<Buffer>;

  // `downloader` replaces the WhatsApp media download (tests).
  constructor(sock: WASocket, downloader?: (message: WAMessage) => Promise<Buffer>) {
    this.sock = sock;
    this.downloader = downloader;
  }

  // Read on every message: the LID can arrive after the socket opens.
  private botIds(): BotIds {
    const me = this.sock.user ?? this.sock.authState?.creds?.me;
    return {
      jid: me?.id ?? '',
      lid: me?.lid ?? this.sock.authState?.creds?.me?.lid ?? ''
    };
  }

  // The file to send pm-agent with this message: its own image/document, or, when someone
  // replies to a screenshot and tags Lady Bachs (or replies to one of hers), the one in
  // the quoted message.
  private async mediaFor(
    msg: proto.IWebMessageInfo,
    inner: proto.IMessage,
    contextInfo: proto.IContextInfo | null,
    addressed: boolean,
    bot: BotIds
  ): Promise<AgentMediaFields | null> {
    const own = pickMedia(inner);
    if (own) {
      return loadMedia(own, () => this.download({ key: msg.key!, message: inner } as WAMessage));
    }
    const quoted = unwrapContent(contextInfo?.quotedMessage);
    const fromQuote = addressed ? pickMedia(quoted) : null;
    if (!fromQuote || !quoted || !contextInfo?.stanzaId) return null;
    const key: proto.IMessageKey = {
      remoteJid: msg.key?.remoteJid,
      id: contextInfo.stanzaId,
      participant: contextInfo.participant,
      fromMe: isBotJid(contextInfo.participant, bot)
    };
    return loadMedia(fromQuote, () => this.download({ key, message: quoted } as WAMessage));
  }

  private async download(message: WAMessage): Promise<Buffer> {
    if (this.downloader) return this.downloader(message);
    return downloadMediaMessage(message, 'buffer', {}, {
      logger,
      reuploadRequest: this.sock.updateMediaMessage
    });
  }

  async handleMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!msg.key) return;

    const jid = msg.key.remoteJid ?? '';

    // Only group messages
    if (!jid.endsWith('@g.us')) {
      logger.debug({ jid }, 'Skipping — not a group message');
      return;
    }

    // Ignore own messages
    if (msg.key.fromMe) return;

    const inner = unwrapMessage(msg);
    logger.debug({ jid, messageKeys: Object.keys(msg.message ?? {}), inner: JSON.stringify(inner) }, 'Raw message received');

    if (!inner) {
      logger.debug({ jid }, 'Skipping — could not unwrap message');
      return;
    }

    const text = extractText(inner);
    logger.debug({ jid, text }, 'Extracted text');

    // A screenshot with no caption still matters to pm-agent; the built-in AI needs words.
    const ownMedia = pickMedia(inner);
    if (!text && !ownMedia) {
      logger.debug({ jid }, 'Skipping — no text or file found');
      return;
    }

    const mentionedJids = extractMentions(inner);
    const bot = this.botIds();
    const contextInfo = findContextInfo(inner);
    const { mentioned: isMentioned, replyToBot: isQuoteReply } = addressingOf(text, contextInfo, bot);
    const addressedToBot = isMentioned || isQuoteReply;
    const quotedId = userPart(contextInfo?.participant);
    logger.debug({ bot, mentionedJids, quoted: contextInfo?.participant, isMentioned, isQuoteReply }, 'Checking mention');

    const route = routeMessage({
      groupJid: jid,
      addressedToBot,
      agentGroups: config.agentGroups,
      agentConfigured: Boolean(config.agentWebhookUrl && config.agentWebhookKey)
    });

    if (route === 'skip') {
      logger.debug({ jid, isMentioned, isQuoteReply }, 'Skipping — not for the AI or pm-agent');
      return;
    }

    const senderJid = msg.key.participant ?? '';

    if (route === 'forward') {
      const quotedInner = unwrapContent(contextInfo?.quotedMessage);
      const quotedText = quotedInner ? extractText(quotedInner) : '';
      const quotedSender = isQuoteReply
        ? 'Lady Bachs'
        : resolveNameByNumber(quotedId) ?? undefined;
      const media = await this.mediaFor(msg, inner, contextInfo, addressedToBot, bot);
      await forwardToAgent(config.agentWebhookUrl, config.agentWebhookKey, {
        message_id: msg.key.id ?? '',
        thread_key: jid,
        sender_id: senderJid,
        sender_name: msg.pushName ?? undefined,
        text,
        quoted_text: quotedText || undefined,
        quoted_sender: quotedText ? quotedSender : undefined,
        mentioned: isMentioned,
        reply_to_bot: isQuoteReply,
        addressed: addressedToBot,
        timestamp: Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
        ...(media ?? {})
      });
      return;
    }

    if (!text) return; // the built-in AI only answers words

    // Replace @number mentions with resolved names so AI has full context
    const cleanText = text.replace(/@(\d+)/g, (_, num) => {
      const name = resolveNameByNumber(num);
      return name ? `@${name}` : `@${num}`;
    }).trim();
    if (!cleanText) return;

    logger.info({ group: jid, sender: senderJid, text: cleanText }, 'Mention received');

    // Auto-register sender
    registerContact(senderJid.split('@')[0].split(':')[0], senderJid);

    // Detect "X is <Name>" or "<Name> is X" patterns for mentioned JIDs
    // e.g. "@246952650362894 is Chimama, save her contact"
    const nameFromMention = extractNameFromIntroduction(text, mentionedJids);
    for (const { name, jid: contactJid } of nameFromMention) {
      registerContact(name, contactJid);
      logger.info({ name, contactJid }, 'Contact registered from introduction');
    }

    try {
      const reply = await generateReply(senderJid, cleanText);

      await this.sock.sendMessage(
        jid,
        {
          text: reply.text,
          ...(reply.mentions.length > 0 && {
            mentions: reply.mentions.map((m) => m.jid)
          })
        },
        { quoted: msg as proto.IWebMessageInfo & { key: proto.IMessageKey } }
      );

      logger.info({ group: jid, mentions: reply.mentions }, 'AI reply sent');
    } catch (err) {
      logger.error({ err }, 'Failed to generate or send AI reply');
    }
  }
}
