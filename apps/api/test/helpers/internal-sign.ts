// HMAC signer matching apps/api/src/middleware/internal-auth.ts.
//
// Used by tests (and, eventually, the Container's worker.py client).

export interface SignedHeaders {
  'x-textral-internal-timestamp': string;
  'x-textral-internal-signature': string;
}

export async function signInternal(
  secret: string,
  method: string,
  path: string,
  body: string,
  timestamp: number = Date.now(),
): Promise<SignedHeaders> {
  const enc = new TextEncoder();
  const bodyHashBuf = await crypto.subtle.digest('SHA-256', enc.encode(body));
  const bodyHashHex = bytesToHex(new Uint8Array(bodyHashBuf));
  const canonical = `${method.toUpperCase()}\n${path}\n${bodyHashHex}\n${timestamp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(canonical));
  return {
    'x-textral-internal-timestamp': String(timestamp),
    'x-textral-internal-signature': bytesToHex(new Uint8Array(sig)),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}
