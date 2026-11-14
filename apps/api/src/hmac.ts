import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPeyPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function verifyPeySignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const cleanHeader = signatureHeader.replace(/^sha256=/i, '').trim();
  const expectedHex = signPeyPayload(rawBody, secret);

  const a = Buffer.from(cleanHeader, 'utf8');
  const b = Buffer.from(expectedHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
