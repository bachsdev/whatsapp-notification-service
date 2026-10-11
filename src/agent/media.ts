import { proto } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger';

// A screenshot or a PDF, not a screen recording. pm-agent caps at 10 MB; base64 adds a third.
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

// The media fields of the body pm-agent's /webhook reads (bachs-agent interface/bachs_notify.py).
export interface AgentMediaFields {
  media_type: 'image' | 'document';
  media_mime: string;
  media_filename?: string;
  media_data: string; // base64
}

export interface MediaSource {
  kind: 'image' | 'document';
  mime: string;
  filename?: string;
  size: number; // declared by WhatsApp; 0 when unknown
}

// Unwrap the layers a quoted message can sit in (a document with a caption, view once).
export function unwrapContent(m: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!m) return null;
  return (
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message ??
    m
  );
}

// The file a message carries, if it is one pm-agent can use (an image or a document).
// Voice notes, stickers and videos are left out.
export function pickMedia(m: proto.IMessage | null | undefined): MediaSource | null {
  if (!m) return null;
  if (m.imageMessage) {
    return {
      kind: 'image',
      mime: m.imageMessage.mimetype || 'image/jpeg',
      size: Number(m.imageMessage.fileLength ?? 0)
    };
  }
  if (m.documentMessage) {
    return {
      kind: 'document',
      mime: m.documentMessage.mimetype || 'application/octet-stream',
      filename: m.documentMessage.fileName || undefined,
      size: Number(m.documentMessage.fileLength ?? 0)
    };
  }
  return null;
}

export type Downloader = () => Promise<Buffer>;

// Download one file and shape it for the forward payload. Too big, or a failed download,
// returns null: the words still go through, only the file is dropped.
export async function loadMedia(
  source: MediaSource,
  download: Downloader,
  maxBytes: number = MAX_MEDIA_BYTES
): Promise<AgentMediaFields | null> {
  if (source.size > maxBytes) {
    logger.warn({ size: source.size, kind: source.kind }, 'Media too large to forward to pm-agent');
    return null;
  }
  let buf: Buffer;
  try {
    buf = await download();
  } catch (err) {
    logger.error({ err, kind: source.kind }, 'Failed to download media for pm-agent');
    return null;
  }
  if (!buf || buf.length === 0 || buf.length > maxBytes) {
    logger.warn({ size: buf?.length ?? 0, kind: source.kind }, 'Media empty or too large to forward');
    return null;
  }
  return {
    media_type: source.kind,
    media_mime: source.mime,
    ...(source.filename ? { media_filename: source.filename } : {}),
    media_data: buf.toString('base64')
  };
}
