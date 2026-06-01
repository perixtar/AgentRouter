import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object
} from "@aws-sdk/client-s3";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  region: string;
  artifactPrefix: string;
}

export interface PutLogChunkInput {
  runId: string;
  stream: "stdout" | "stderr";
  chunkNumber: number;
  body: Buffer;
  eventSequenceStart: bigint;
  eventSequenceEnd: bigint;
  redactionStatus: "redacted" | "not_required";
}

export interface LogChunkArtifact {
  r2Key: string;
  contentType: "application/x-ndjson";
  contentEncoding: "gzip";
  uncompressedSizeBytes: number;
  compressedSizeBytes: number;
  sha256: string;
  metadata: {
    eventSequenceStart: string;
    eventSequenceEnd: string;
    redactionStatus: string;
  };
}

export interface PutArtifactInput {
  runId: string;
  path: string;
  body: Buffer;
  contentType: string;
  contentEncoding?: string;
  metadata?: Record<string, string>;
}

export interface StoredArtifact {
  r2Key: string;
  contentType: string;
  contentEncoding?: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, string>;
}

export class R2ArtifactStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly config: R2Config) {
    this.prefix = ensureTrailingSlash(config.artifactPrefix);
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
  }

  async putLogChunk(input: PutLogChunkInput): Promise<LogChunkArtifact> {
    const compressed = gzipSync(input.body);
    const r2Key = this.logChunkKey(input.runId, input.stream, input.chunkNumber);
    const sha256 = hashSha256(compressed);
    const metadata = {
      eventSequenceStart: input.eventSequenceStart.toString(),
      eventSequenceEnd: input.eventSequenceEnd.toString(),
      redactionStatus: input.redactionStatus
    };

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: r2Key,
        Body: compressed,
        ContentType: "application/x-ndjson",
        ContentEncoding: "gzip",
        Metadata: {
          "sha256": sha256,
          "uncompressed-size-bytes": input.body.byteLength.toString(),
          "compressed-size-bytes": compressed.byteLength.toString(),
          "event-sequence-start": metadata.eventSequenceStart,
          "event-sequence-end": metadata.eventSequenceEnd,
          "redaction-status": metadata.redactionStatus
        }
      })
    );

    return {
      r2Key,
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
      uncompressedSizeBytes: input.body.byteLength,
      compressedSizeBytes: compressed.byteLength,
      sha256,
      metadata
    };
  }

  async putArtifact(input: PutArtifactInput): Promise<StoredArtifact> {
    const safePath = input.path.replace(/^\/+/, "");
    if (safePath.includes("..")) {
      throw new Error(`Artifact path cannot contain '..': ${input.path}`);
    }

    const r2Key = `${this.runPrefix(input.runId)}${safePath}`;
    const sha256 = hashSha256(input.body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: r2Key,
        Body: input.body,
        ContentType: input.contentType,
        ContentEncoding: input.contentEncoding,
        Metadata: {
          ...input.metadata,
          "sha256": sha256,
          "size-bytes": input.body.byteLength.toString()
        }
      })
    );

    return {
      r2Key,
      contentType: input.contentType,
      contentEncoding: input.contentEncoding,
      sizeBytes: input.body.byteLength,
      sha256,
      metadata: {
        ...input.metadata,
        sha256,
        sizeBytes: input.body.byteLength.toString()
      }
    };
  }

  async getObjectBytes(key: string): Promise<Buffer> {
    assertKeyInPrefix(key, this.prefix);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key
      })
    );

    if (!response.Body) {
      return Buffer.alloc(0);
    }

    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async listRunKeys(runId: string): Promise<string[]> {
    const prefix = this.runPrefix(runId);
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      );

      keys.push(...(response.Contents ?? []).map((object: _Object) => object.Key).filter(isString));
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  async deleteRunPrefix(runId: string): Promise<void> {
    const keys = await this.listRunKeys(runId);

    for (let offset = 0; offset < keys.length; offset += 1000) {
      const chunk = keys.slice(offset, offset + 1000);
      if (chunk.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: {
            Objects: chunk.map((Key) => ({ Key })),
            Quiet: true
          }
        })
      );
    }
  }

  private logChunkKey(runId: string, stream: "stdout" | "stderr", chunkNumber: number): string {
    const padded = String(chunkNumber).padStart(6, "0");
    return `${this.runPrefix(runId)}logs/${stream}/${padded}.ndjson.gz`;
  }

  private runPrefix(runId: string): string {
    return `${this.prefix}${runId}/`;
  }
}

function hashSha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function assertKeyInPrefix(key: string, prefix: string): void {
  if (!key.startsWith(prefix)) {
    throw new Error(`R2 key outside configured artifact prefix: ${key}`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
