// S3 → BlobStore adapter. Targets MinIO by default; any
// S3-compatible endpoint (Wasabi, Backblaze, Cloudflare R2 with
// access keys) works via `forcePathStyle` + a custom endpoint URL.
//
// Bucket name is supplied at construction time; the store wraps a
// pre-configured `S3Client`. Failed `get`/`head` distinguish
// `NoSuchKey` / `NotFound` (return null) from other errors (rethrow).

import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type {
  BlobBody,
  BlobGet,
  BlobHead,
  BlobPutOpts,
  BlobStore,
} from '../shared/interfaces.js';

async function bufferStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class S3BlobStore implements BlobStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: BlobBody, opts?: BlobPutOpts): Promise<void> {
    // S3 + sigv4 + flexible-checksums requires ContentLength for
    // streamed bodies. CF R2's `put` accepts unbounded ReadableStreams
    // for free; to preserve that contract here, buffer ReadableStream
    // bodies into a Uint8Array first. This costs memory equal to the
    // upload size for the duration of the call. The doc-ingest hot
    // path passes either a Uint8Array (raw upload) or a stream from
    // `blobs.get(...)` (recover-or-create copy) — both fit in memory
    // for typical document sizes (<100 MB). Operators uploading
    // larger artifacts should use the multipart-upload path
    // (lib-storage Upload class) directly — out of scope here.
    let Body: Uint8Array | string;
    if (body instanceof ReadableStream) {
      Body = await bufferStream(body as ReadableStream<Uint8Array>);
    } else if (body instanceof Uint8Array) {
      Body = body;
    } else if (typeof body === 'string') {
      Body = body;
    } else {
      Body = new Uint8Array(body);
    }
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body,
        ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
        ...(opts?.metadata ? { Metadata: opts.metadata } : {}),
      }),
    );
  }

  async get(key: string): Promise<BlobGet | null> {
    try {
      const r = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!r.Body) return null;
      // SDK returns Body as Readable | ReadableStream | Blob.
      // Normalize to web ReadableStream (the BlobStore contract).
      const body = (
        r.Body instanceof Readable
          ? Readable.toWeb(r.Body as Readable)
          : (r.Body as unknown as ReadableStream<Uint8Array>)
      ) as ReadableStream<Uint8Array>;
      return {
        body,
        ...(r.ContentType ? { contentType: r.ContentType } : {}),
        ...(r.ContentLength != null ? { size: r.ContentLength } : {}),
      };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw e;
    }
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const r = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: r.ContentLength ?? 0,
        ...(r.ContentType ? { contentType: r.ContentType } : {}),
        ...(r.Metadata ? { metadata: r.Metadata } : {}),
      };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
