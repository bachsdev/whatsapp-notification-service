import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { proto, WASocket } from '@whiskeysockets/baileys';

// config reads these when it is first loaded, so they are set before the handler is required.
const GROUP = '120363413110390769@g.us';
process.env.AGENT_GROUPS = GROUP;
process.env.AGENT_WEBHOOK_URL = 'http://pm-agent.test';
process.env.AGENT_WEBHOOK_KEY = 'test-key';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MessageHandler } = require('../src/handlers/message-handler') as typeof import('../src/handlers/message-handler');

const BOT_LID = '99887766@lid';
const sock = {
  user: { id: '2348000000001:5@s.whatsapp.net', lid: '99887766:5@lid' },
  sendMessage: async () => undefined,
  updateMediaMessage: async () => undefined
} as unknown as WASocket;

const PNG = Buffer.from('fake-png');
let sent: any[] = [];
let downloaded: proto.IMessageKey[] = [];

beforeEach(() => {
  sent = [];
  downloaded = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
});

function handler() {
  return new MessageHandler(sock, async (m) => {
    downloaded.push(m.key);
    return PNG;
  });
}

function groupMessage(id: string, message: proto.IMessage): proto.IWebMessageInfo {
  return {
    key: { remoteJid: GROUP, id, participant: '11223344@lid', fromMe: false },
    pushName: 'Ada',
    messageTimestamp: 1752600000,
    message
  };
}

test('1. an untagged reply to her is forwarded as addressed, with her message quoted', async () => {
  await handler().handleMessage(groupMessage('m1', {
    extendedTextMessage: {
      text: 'and the second one?',
      contextInfo: { stanzaId: 'her1', participant: BOT_LID, quotedMessage: { conversation: 'BAC-12 and BAC-14 are stuck' } }
    }
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].addressed, true);
  assert.equal(sent[0].reply_to_bot, true);
  assert.equal(sent[0].mentioned, false);
  assert.equal(sent[0].quoted_text, 'BAC-12 and BAC-14 are stuck');
  assert.equal(sent[0].quoted_sender, 'Lady Bachs');
});

test('2. a tag on a reply to someone else is forwarded as addressed, with their message quoted', async () => {
  await handler().handleMessage(groupMessage('m2', {
    extendedTextMessage: {
      text: '@99887766 look into this',
      contextInfo: {
        stanzaId: 'tega1', participant: '55667788@lid',
        quotedMessage: { conversation: 'checkout times out on mobile' },
        mentionedJid: [BOT_LID]
      }
    }
  }));
  assert.equal(sent[0].addressed, true);
  assert.equal(sent[0].mentioned, true);
  assert.equal(sent[0].reply_to_bot, false);
  assert.equal(sent[0].quoted_text, 'checkout times out on mobile');
});

test('3a. an image with a tagged caption carries the image', async () => {
  await handler().handleMessage(groupMessage('m3', {
    imageMessage: {
      mimetype: 'image/png', fileLength: PNG.length, caption: '@99887766 what is this error?',
      contextInfo: { mentionedJid: [BOT_LID] }
    }
  }));
  assert.equal(sent[0].addressed, true);
  assert.equal(sent[0].text, '@99887766 what is this error?');
  assert.equal(sent[0].media_type, 'image');
  assert.equal(sent[0].media_mime, 'image/png');
  assert.equal(sent[0].media_data, PNG.toString('base64'));
});

test('3b. a tagged reply to someone else\'s image carries the quoted image', async () => {
  await handler().handleMessage(groupMessage('m4', {
    extendedTextMessage: {
      text: '@99887766 can you fix this?',
      contextInfo: {
        stanzaId: 'img1', participant: '55667788@lid', mentionedJid: [BOT_LID],
        quotedMessage: { imageMessage: { mimetype: 'image/jpeg', caption: 'broken screen', fileLength: PNG.length } }
      }
    }
  }));
  assert.equal(sent[0].addressed, true);
  assert.equal(sent[0].quoted_text, 'broken screen');
  assert.equal(sent[0].media_type, 'image');
  assert.equal(sent[0].media_data, PNG.toString('base64'));
  assert.equal(downloaded[0].id, 'img1');
  assert.equal(downloaded[0].participant, '55667788@lid');
});

test('4. a plain group message is forwarded as not addressed, with no file pulled', async () => {
  await handler().handleMessage(groupMessage('m5', {
    extendedTextMessage: {
      text: 'nice one',
      contextInfo: {
        stanzaId: 'x1', participant: '55667788@lid',
        quotedMessage: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } }
      }
    }
  }));
  assert.equal(sent[0].addressed, false);
  assert.equal(sent[0].mentioned, false);
  assert.equal(sent[0].reply_to_bot, false);
  assert.equal(sent[0].media_data, undefined);
  assert.equal(downloaded.length, 0);
});
