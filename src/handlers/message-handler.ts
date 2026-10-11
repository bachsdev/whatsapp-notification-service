import { WAMessage, WASocket, downloadMediaMessage, proto } from '@whiskeysockets/baileys';
import { generateReply } from '../ai/ai';
import { registerContact, resolveNameByNumber } from '../ai/contacts';
import { forwardToAgent } from '../agent/forwarder';
import { AgentMediaFields, loadMedia, pickMedia, unwrapContent } from '../agent/media';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { routeMessage } from './routing';

// Unwrap all the common message wrapper layers and return the inner IMessage
function unwrapMessage(msg: proto.IWebMessageInfo): proto.IMessage | null {
  const m = msg.message;
  if (!m) return null;

  return (
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message?.viewOnceMessage?.message ??
    m.documentWithCaptionMessage?.message ??
    m
  );
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

function extractContextInfo(m: proto.IMessage): proto.IContextInfo | null {
  return (
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    null
  );
}

// Extract mentioned JIDs from any context layer
function extractMentions(m: proto.IMessage): string[] {
  return (
    m.extendedTextMessage?.contextInfo?.mentionedJid ??
    m.imageMessage?.contextInfo?.mentionedJid ??
    m.videoMessage?.contextInfo?.mentionedJid ??
    m.documentMessage?.contextInfo?.mentionedJid ??
    []
  );
}

export class MessageHandler {
  private sock: WASocket;
  private botJid: string = '';
  private botLid: string = '';

  constructor(sock: WASocket) {
    this.sock = sock;
    if (sock.user) {
      this.botJid = sock.user.id;
      // LID is stored as sock.user.lid on newer WhatsApp multi-device accounts
      this.botLid = (sock.user as any).lid ?? '';
    }
  }

  // The file to send pm-agent with this message: its own image/document, or, when someone
  // replies to a screenshot and tags Lady Bachs, the one in the quoted message.
  private async mediaFor(
    msg: proto.IWebMessageInfo,
    inner: proto.IMessage,
    contextInfo: proto.IContextInfo | null,
    isMentioned: boolean
  ): Promise<AgentMediaFields | null> {
    const own = pickMedia(inner);
    if (own) {
      return loadMedia(own, () => this.download({ key: msg.key!, message: inner } as WAMessage));
    }
    const quoted = unwrapContent(contextInfo?.quotedMessage);
    const fromQuote = isMentioned ? pickMedia(quoted) : null;
    if (!fromQuote || !quoted || !contextInfo?.stanzaId) return null;
    const key: proto.IMessageKey = {
      remoteJid: msg.key?.remoteJid,
      id: contextInfo.stanzaId,
      participant: contextInfo.participant,
      fromMe: false
    };
    return loadMedia(fromQuote, () => this.download({ key, message: quoted } as WAMessage));
  }

  private async download(message: WAMessage): Promise<Buffer> {
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
    const botNumber = this.botJid.split(':')[0] + '@s.whatsapp.net';
    const botLidNumber = this.botLid ? this.botLid.split('@')[0].split(':')[0] : '';
    logger.debug({ botJid: this.botJid, botLid: this.botLid, botNumber, botLidNumber, mentionedJids }, 'Checking mention');

    const isMentioned = mentionedJids.some((m) => {
      const numericId = m.split('@')[0].split(':')[0];
      if (m.endsWith('@lid')) return numericId === botLidNumber;
      return numericId + '@s.whatsapp.net' === botNumber;
    });

    const contextInfo = extractContextInfo(inner);
    const quotedParticipant = contextInfo?.participant ?? '';
    const quotedId = quotedParticipant.split('@')[0].split(':')[0];
    const isQuoteReply = quotedParticipant !== '' && (quotedId === botLidNumber || quotedParticipant === botNumber);

    const route = routeMessage({
      groupJid: jid,
      addressedToBot: isMentioned || isQuoteReply,
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
      const media = await this.mediaFor(msg, inner, contextInfo, isMentioned);
      await forwardToAgent(config.agentWebhookUrl, config.agentWebhookKey, {
        message_id: msg.key.id ?? '',
        thread_key: jid,
        sender_id: senderJid,
        sender_name: msg.pushName ?? undefined,
        text,
        quoted_text: quotedText || undefined,
        quoted_sender: quotedText ? quotedSender : undefined,
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
