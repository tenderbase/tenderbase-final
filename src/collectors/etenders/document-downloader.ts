import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { db } from '../../db.js';

const BASE_URL = (process.env.ETENDERS_WEB_BASE_URL ?? 'https://www.etenders.gov.za').replace(/\/$/, '');
const STORAGE_ROOT = process.env.DOCUMENT_STORAGE_PATH ?? '/tmp/tenderbase-documents';
const TIMEOUT_MS = Number(process.env.ETENDERS_DOCUMENT_TIMEOUT_MS ?? 60000);
const MAX_BYTES = Number(process.env.ETENDERS_DOCUMENT_MAX_BYTES ?? 50 * 1024 * 1024);

function safeFilename(name: string): string {
  const cleaned = basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return cleaned || 'document.bin';
}

function downloadUrl(blobName: string, downloadedFileName: string): string {
  const url = new URL('/home/Download/', BASE_URL);
  url.searchParams.set('blobName', blobName);
  url.searchParams.set('downloadedFileName', downloadedFileName);
  return url.toString();
}

export async function downloadDocument(documentId: string) {
  const document = await db.document.findUnique({ where: { id: documentId } });
  if (!document) throw new Error(`Document ${documentId} not found`);
  if (!document.blobName) throw new Error(`Document ${documentId} has no eTenders blobName`);

  const filename = safeFilename(document.downloadedFileName ?? document.blobName);
  const url = downloadUrl(document.blobName, filename);
  const directory = join(STORAGE_ROOT, document.tenderId);
  const finalPath = join(directory, filename);
  const tempPath = `${finalPath}.part`;

  await db.document.update({ where: { id: document.id }, data: { downloadStatus: 'downloading', lastDownloadError: null, url } });
  await mkdir(directory, { recursive: true });

  try {
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
    } finally {
      clearTimeout(timer);
    }

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
    } finally {
      reader.releaseLock();
    }

    const data = Buffer.concat(chunks);
    const checksum = hash.digest('hex');
    await import('node:fs/promises').then(fs => fs.writeFile(tempPath, data));
    await rename(tempPath, finalPath);
    const fileInfo = await stat(finalPath);

    await db.document.update({ where: { id: document.id }, data: {
      downloadStatus: 'downloaded',
      storagePath: finalPath,
      fileSize: BigInt(fileInfo.size),
      checksum,
      downloadedAt: new Date(),
      lastDownloadError: null,
      url,
    } });

    return { documentId: document.id, tenderId: document.tenderId, filename, url, storagePath: finalPath, bytes: fileInfo.size, checksum };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
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
    }
  }
  return results;
}

export { downloadUrl };
