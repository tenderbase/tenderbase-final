import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type DocumentStorageProvider = {
  readonly name: string;
  readonly bucket: string;
  putObject(input: { key: string; body: Buffer; contentType?: string; metadata?: Record<string, string> }): Promise<{ key: string; bytes: number }>;
  headObject(key: string): Promise<{ key: string; bytes: number; contentType?: string }>;
  getDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required storage environment variable ${name}`);
  return value;
}

class R2DocumentStorage implements DocumentStorageProvider {
  readonly name = 'cloudflare-r2';
  readonly bucket = required('R2_BUCKET_NAME');
  private readonly client: S3Client;

  constructor() {
    const accountId = required('R2_ACCOUNT_ID');
    this.client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      },
    });
  }

  async putObject(input: { key: string; body: Buffer; contentType?: string; metadata?: Record<string, string> }) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      Metadata: input.metadata,
    }));
    return { key: input.key, bytes: input.body.byteLength };
  }

  async headObject(key: string) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return { key, bytes: Number(result.ContentLength ?? 0), contentType: result.ContentType };
  }

  async getDownloadUrl(key: string, expiresInSeconds = 300) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }
}

export function createDocumentStorageProvider(): DocumentStorageProvider {
  const provider = (process.env.DOCUMENT_STORAGE_PROVIDER ?? 'r2').toLowerCase();
  if (provider !== 'r2') throw new Error(`Unsupported DOCUMENT_STORAGE_PROVIDER "${provider}". Add another DocumentStorageProvider implementation before using it.`);
  return new R2DocumentStorage();
}
