// R2 upload + read helpers.
//
// Phase 5 cleanup (audit §6) committed to the Worker-proxy as the
// only path:
//
//   * Consumers PUT to /v1/documents/{id}/uploads/{upload_id}/data
//     with their API key. The Worker writes to R2 via the binding.
//   * Containers POST to /internal/r2/object (HMAC-signed) to read
//     bytes back during the fetch stage.
//
// The presigned-URL fallback was removed. R2 bindings don't expose
// `createPresignedUrl`; the prior sentinel-URL fallback was dead in
// every deployment. If a future deploy provisions S3-compatible R2
// access keys, presigning can come back as an additive change.


const UPLOAD_TTL_MS = 15 * 60 * 1000;

export interface UploadEndpoint {
  /** Worker-proxy URL the consumer PUTs to. The handler at the
   *  matching route validates the upload_intents row and writes to R2. */
  url: string;
  expires_at: number;
}

/** Build the consumer-facing PUT URL. Always Worker-proxied. */
export function buildUploadEndpoint(
  requestUrl: string,
  documentId: string,
  uploadId: string,
): UploadEndpoint {
  const origin = new URL(requestUrl).origin;
  return {
    url: `${origin}/v1/documents/${documentId}/uploads/${uploadId}/data`,
    expires_at: Date.now() + UPLOAD_TTL_MS,
  };
}

export function uploadKey(
  tenantId: string,
  namespaceId: string,
  documentId: string,
  uploadId: string,
  ext: string,
): string {
  const cleanExt = ext.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return `${tenantId}/${namespaceId}/${documentId}/uploads/${uploadId}/source.${cleanExt}`;
}

export function canonicalSourceKey(
  tenantId: string,
  namespaceId: string,
  documentId: string,
  versionId: string,
  ext: string,
): string {
  const cleanExt = ext.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return `${tenantId}/${namespaceId}/${documentId}/${versionId}/source.${cleanExt}`;
}

export function extFromContentType(contentType: string): string {
  const ct = contentType.toLowerCase().split(';')[0]!.trim();
  switch (ct) {
    case 'text/plain':
      return 'txt';
    case 'text/markdown':
    case 'text/x-markdown':
      return 'md';
    case 'application/json':
      return 'json';
    case 'application/epub+zip':
    case 'application/epub':
      return 'epub';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

