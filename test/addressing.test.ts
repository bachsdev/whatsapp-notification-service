import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { addressingOf, BotIds, findContextInfo, isBotJid } from '../src/handlers/addressing';
import { unwrapContent } from '../src/agent/media';

// The bot as WhatsApp names it: a phone JID and a LID, both with a device suffix.
const BOT: BotIds = { jid: '2348000000001:5@s.whatsapp.net', lid: '99887766:5@lid' };

test('the bot is recognised by its phone JID or its LID, with or without a device', () => {
  assert.equal(isBotJid('2348000000001@s.whatsapp.net', BOT), true);
  assert.equal(isBotJid('2348000000001:12@s.whatsapp.net', BOT), true);
  assert.equal(isBotJid('99887766@lid', BOT), true);
  assert.equal(isBotJid('99887766:3@lid', BOT), true);
  assert.equal(isBotJid('2348011112222@s.whatsapp.net', BOT), false);
  assert.equal(isBotJid('11223344@lid', BOT), false);
  assert.equal(isBotJid('', BOT), false);
  assert.equal(isBotJid(undefined, { jid: '', lid: '' }), false);
});

test('an untagged reply to her message is addressed to her (LID participant)', () => {
  const ctx: proto.IContextInfo = {
    stanzaId: 'ABC', participant: '99887766@lid', quotedMessage: { conversation: 'BAC-12 is stuck' }
  };
  assert.deepEqual(addressingOf('why?', ctx, BOT), { mentioned: false, replyToBot: true });
});

test('an untagged reply to her message is addressed to her (phone participant)', () => {
  const ctx: proto.IContextInfo = {
    stanzaId: 'ABC', participant: '2348000000001@s.whatsapp.net', quotedMessage: { conversation: 'x' }
  };
  assert.equal(addressingOf('and then?', ctx, BOT).replyToBot, true);
});

test('a tag on a reply to someone else is a mention, not a reply to her', () => {
  const ctx: proto.IContextInfo = {
    stanzaId: 'DEF',
    participant: '11223344@lid',
    quotedMessage: { conversation: 'checkout is down' },
    mentionedJid: ['99887766@lid']
  };
  assert.deepEqual(addressingOf('@99887766 look into this', ctx, BOT), {
    mentioned: true, replyToBot: false
  });
});

test('a tag by phone JID counts too', () => {
  const ctx: proto.IContextInfo = { mentionedJid: ['2348000000001@s.whatsapp.net'] };
  assert.equal(addressingOf('@2348000000001 hi', ctx, BOT).mentioned, true);
});

test('a tag whose mentionedJid list is missing is still caught from the text', () => {
  assert.equal(addressingOf('@99887766 hi', null, BOT).mentioned, true);
  assert.equal(addressingOf('@998877661 hi', null, BOT).mentioned, false);
});

test('a plain message, or one tagging someone else, is not addressed to her', () => {
  assert.deepEqual(addressingOf('lunch?', null, BOT), { mentioned: false, replyToBot: false });
  const other: proto.IContextInfo = {
    stanzaId: 'GHI', participant: '11223344@lid', quotedMessage: { conversation: 'x' },
    mentionedJid: ['11223344@lid']
  };
  assert.deepEqual(addressingOf('@11223344 agreed', other, BOT), { mentioned: false, replyToBot: false });
});

test('the context of an image caption, a document or a sticker is found', () => {
  const ctx: proto.IContextInfo = { mentionedJid: ['99887766@lid'] };
  assert.equal(findContextInfo({ imageMessage: { caption: '@99887766 what is this', contextInfo: ctx } }), ctx);
  assert.equal(findContextInfo({ documentMessage: { contextInfo: ctx } }), ctx);
  assert.equal(findContextInfo({ stickerMessage: { contextInfo: ctx } }), ctx);
  assert.equal(findContextInfo({ conversation: 'hi' }), null);
});

test('a view-once image inside a disappearing message is unwrapped to the image', () => {
  const m: proto.IMessage = {
    ephemeralMessage: {
      message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'look' } } } }
    }
  };
  assert.equal(unwrapContent(m)?.imageMessage?.caption, 'look');
});
