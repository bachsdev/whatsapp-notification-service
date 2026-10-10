import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { loadMedia, pickMedia, unwrapContent } from '../src/agent/media';

test('an image is picked with its mime type and size', () => {
  const m: proto.IMessage = { imageMessage: { mimetype: 'image/png', fileLength: 1234, caption: 'error' } };
  assert.deepEqual(pickMedia(m), { kind: 'image', mime: 'image/png', size: 1234 });
});

test('a document keeps its file name', () => {
  const m: proto.IMessage = {
    documentMessage: { mimetype: 'application/pdf', fileName: 'statement.pdf', fileLength: 10 }
  };
  assert.deepEqual(pickMedia(m), {
    kind: 'document', mime: 'application/pdf', filename: 'statement.pdf', size: 10
  });
});

test('voice notes, stickers and plain text carry no file', () => {
  assert.equal(pickMedia({ audioMessage: { mimetype: 'audio/ogg' } }), null);
  assert.equal(pickMedia({ stickerMessage: {} }), null);
  assert.equal(pickMedia({ conversation: 'hi' }), null);
  assert.equal(pickMedia(null), null);
});

test('a quoted document with a caption is unwrapped', () => {
  const quoted: proto.IMessage = {
    documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf' } } }
  };
  assert.equal(pickMedia(unwrapContent(quoted))?.kind, 'document');
});

test('a downloaded file becomes base64 media fields', async () => {
  const out = await loadMedia({ kind: 'image', mime: 'image/jpeg', size: 3 }, async () => Buffer.from('abc'));
  assert.deepEqual(out, { media_type: 'image', media_mime: 'image/jpeg', media_data: 'YWJj' });
});

test('a file over the cap is not downloaded', async () => {
  let called = false;
  const out = await loadMedia({ kind: 'image', mime: 'image/jpeg', size: 100 }, async () => {
    called = true;
    return Buffer.from('x');
  }, 10);
  assert.equal(out, null);
  assert.equal(called, false);
});

test('a download bigger than the cap is dropped even when the size was not declared', async () => {
  const out = await loadMedia({ kind: 'image', mime: 'image/jpeg', size: 0 }, async () => Buffer.alloc(11), 10);
  assert.equal(out, null);
});

test('a failed download drops only the file', async () => {
  const out = await loadMedia({ kind: 'document', mime: 'application/pdf', size: 1 }, async () => {
    throw new Error('expired');
  });
  assert.equal(out, null);
});
