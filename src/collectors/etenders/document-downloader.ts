import { createHash } from 'node:crypto';
import { db } from '../../db.js';
import { createDocumentStorageProvider } from '../../storage/document-storage.js';

const BASE_URL = (process.env.ETENDERS_WEB_BASE_URL ?? 'https://www.etenders.gov.za').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.ETENDERS_DOCUMENT_TIMEOUT_MS ?? 60000);
const MAX_BYTES = Number(process.env.ETENDERS_DOCUMENT_MAX_BYTES ?? 50 * 1024 * 1024);

function safeFilename(name: string): string {
  const cleaned = name.split(/[\\/]/).pop()?.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim();
  return cleaned || 'document.bin';
}

function contentTypeFor(filename: string, format?: string | null): string | undefined {
  if (format?.includes('/')) return format;
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  return undefined;
}

function downloadUrl(blobName: string, downloadedFileName: string): string {
  const url = new URL('/home/Download/', BASE_URL);
  url.searchParams.set('blobName', blobName);
  url.searchParams.set('downloadedFileName', downloadedFileName);
  return url.toString();
}

function storageKey(tenderId: string, documentId: string, filename: string): string {
  return `etenders/${tenderId}/${documentId}/${filename}`;
}

export async function downloadDocument(documentId: string) {
  const document = await db.document.findUnique({ where: { id: documentId } });
  if (!document) throw new Error(`Document ${documentId} not found`);
  if (!document.blobName) throw new Error(`Document ${documentId} has no eTenders blobName`);

  const filename = safeFilename(document.downloadedFileName ?? document.blobName);
  const url = downloadUrl(document.blobName, filename);
  await db.document.update({ where: { id: document.id }, data: { downloadStatus: 'downloading', lastDownloadError: null, url } });

  try {
    const storage = createDocumentStorageProvider();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/octet-stream, application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, */*',
          'user-agent': 'TenderBase/1.0 eTenders document collector',
          referer: `${BASE_URL}/Home/opportunities?id=1`,
        },
      });
    } finally { clearTimeout(timer); }

    if (!response.ok) throw new Error(`eTenders document HTTP ${response.status}`);
    if (!response.body) throw new Error('eTenders document response has no body');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_BYTES) throw new Error(`Document exceeds ${MAX_BYTES} byte limit`);

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) throw new Error(`Document exceeds ${MAX_BYTES} byte limit`);
        const chunk = Buffer.from(value);
        hash.update(chunk);
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }

    const data = Buffer.concat(chunks);
    const checksum = hash.digest('hex');
    const key = storageKey(document.tenderId, document.documentId, filename);
    const stored = await storage.putObject({ key, body: data, contentType: contentTypeFor(filename, document.format), metadata: { source: 'etenders', documentId: document.documentId, checksum } });
    const verified = await storage.headObject(key);
    if (verified.bytes !== data.byteLength) throw new Error(`Storage verification failed: expected ${data.byteLength} bytes, got ${verified.bytes}`);

    await db.document.update({ where: { id: document.id }, data: {
      downloadStatus: 'downloaded', storageProvider: storage.name, storageBucket: storage.bucket, storagePath: stored.key,
      fileSize: BigInt(stored.bytes), checksum, downloadedAt: new Date(), lastDownloadError: null, url,
    } });

    return { documentId: document.id, tenderId: document.tenderId, filename, url, storageProvider: storage.name, storageBucket: storage.bucket, storagePath: stored.key, bytes: stored.bytes, checksum };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.document.update({ where: { id: document.id }, data: { downloadStatus: 'failed', lastDownloadError: message, url } });
    throw error;
  }
}

export async function downloadDiscoveredDocuments(tenderId: string) {
  const documents = await db.document.findMany({ where: { tenderId, blobName: { not: null }, downloadStatus: { not: 'downloaded' } }, select: { id: true } });
  const results: Array<Awaited<ReturnType<typeof downloadDocument>>> = [];
  for (const document of documents) {
    try {
      results.push(await downloadDocument(document.id));
    } catch (error) {
      console.error(JSON.stringify({ service: 'etenders-document-downloader', documentId: document.id, tenderId, error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }
  return results;
}

export { downloadUrl };
