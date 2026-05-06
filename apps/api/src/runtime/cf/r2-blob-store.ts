// R2 → BlobStore adapter. Translates the runtime-shared `BlobStore`
// interface onto the Cloudflare R2 binding API.
//
// Field-name translation: BlobStore uses flat `{ contentType,
// metadata }` shape; R2 nests as `{ httpMetadata, customMetadata }`.

import type {
  BlobBody,
  BlobGet,
  BlobHead,
  BlobPutOpts,
  BlobStore,
} from '../shared/interfaces.js';

export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: BlobBody, opts?: BlobPutOpts): Promise<void> {
    await this.bucket.put(key, body, {
      ...(opts?.contentType
        ? { httpMetadata: { contentType: opts.contentType } }
        : {}),
      ...(opts?.metadata ? { customMetadata: opts.metadata } : {}),
    });
  }

  async get(key: string): Promise<BlobGet | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const ct = obj.httpMetadata?.contentType;
    return {
      body: obj.body,
      ...(ct ? { contentType: ct } : {}),
      size: obj.size,
    };
  }

  async head(key: string): Promise<BlobHead | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    const ct = obj.httpMetadata?.contentType;
    return {
      size: obj.size,
      ...(ct ? { contentType: ct } : {}),
      ...(obj.customMetadata ? { metadata: obj.customMetadata } : {}),
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
