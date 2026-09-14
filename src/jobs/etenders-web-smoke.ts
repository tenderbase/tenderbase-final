import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';
import { downloadDiscoveredDocuments } from '../collectors/etenders/document-downloader.js';
import { db } from '../db.js';

const client = new EtendersWebClient();
const length = Math.min(Math.max(Number(process.env.ETENDERS_SMOKE_LENGTH ?? 10), 1), 25);
const page = await client.getOpportunities({ length, status: 1 });

let succeeded = 0;
let failed = 0;
let documentsDiscovered = 0;
let documentsResolved = 0;
let documentsDownloaded = 0;
const errors: string[] = [];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function blobNameFor(documentId: string, filename: string | null | undefined): string {
  if (!filename) return `${documentId}.bin`;
  const match = filename.match(/\.([A-Za-z0-9]{1,10})$/);
  return match ? `${documentId}.${match[1]}` : `${documentId}.bin`;
}

for (const release of page.releases) {
  try {
    const result = await persistRelease(release);
    succeeded++;
    documentsDiscovered += result.documents ?? 0;

    if (result.normalized && result.tenderId) {
      const documents = await db.document.findMany({
        where: { tenderId: result.tenderId },
        select: { id: true, documentId: true, downloadedFileName: true, title: true, blobName: true },
      });

      for (const document of documents) {
        if (!uuid.test(document.documentId)) continue;
        const filename = document.downloadedFileName ?? document.title ?? `${document.documentId}.bin`;
        const blobName = blobNameFor(document.documentId, filename);
        const needsResolution = !document.blobName || document.blobName === document.documentId || !/[.][A-Za-z0-9]{1,10}$/.test(document.blobName);
        if (needsResolution) {
          const url = `https://www.etenders.gov.za/home/Download/?blobName=${encodeURIComponent(blobName)}&downloadedFileName=${encodeURIComponent(filename)}`;
          await db.document.update({
            where: { id: document.id },
            data: { blobName, downloadedFileName: filename, url, downloadStatus: 'discovered', lastDownloadError: null },
          });
          documentsResolved++;
        }
      }
    }
  } catch (error) {
    failed++;
    errors.push(`${release.ocid}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Force exactly one real document through the current storage provider even when
// the database already contains documents downloaded by the old /tmp provider.
const smokeDocument = await db.document.findFirst({
  where: { blobName: { not: null }, documentId: { not: '' } },
  orderBy: { downloadedAt: 'desc' },
  select: { id: true, tenderId: true, documentId: true, blobName: true, downloadedFileName: true, title: true },
});

if (!smokeDocument) {
  failed++;
  errors.push('No downloadable eTenders document is available for storage smoke verification');
} else {
  const filename = smokeDocument.downloadedFileName ?? smokeDocument.title ?? `${smokeDocument.documentId}.bin`;
  const blobName = uuid.test(smokeDocument.documentId) ? blobNameFor(smokeDocument.documentId, filename) : smokeDocument.blobName!;
  const url = `https://www.etenders.gov.za/home/Download/?blobName=${encodeURIComponent(blobName)}&downloadedFileName=${encodeURIComponent(filename)}`;
  await db.document.update({
    where: { id: smokeDocument.id },
    data: { blobName, downloadedFileName: filename, url, downloadStatus: 'discovered', storageProvider: null, storageBucket: null, storagePath: null, fileSize: null, checksum: null, downloadedAt: null, lastDownloadError: null },
  });

  try {
    const downloads = await downloadDiscoveredDocuments(smokeDocument.tenderId);
    documentsDownloaded = downloads.length;
    if (documentsDownloaded !== 1) {
      failed++;
      errors.push(`Storage smoke expected exactly 1 document download, got ${documentsDownloaded}`);
    }
  } catch (error) {
    failed++;
    errors.push(`Storage smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const counts = {
  tenders: await db.tender.count(),
  releases: await db.release.count(),
  sourceRecords: await db.sourceRecord.count(),
  organizations: await db.organization.count(),
  awards: await db.award.count(),
  contracts: await db.contract.count(),
  documents: await db.document.count(),
  downloadedDocuments: await db.document.count({ where: { downloadStatus: 'downloaded' } }),
};

const sampleDocuments = await db.document.findMany({
  orderBy: { downloadedAt: 'desc' },
  take: 10,
  select: {
    id: true,
    tenderId: true,
    documentId: true,
    title: true,
    format: true,
    blobName: true,
    downloadedFileName: true,
    downloadStatus: true,
    storageProvider: true,
    storageBucket: true,
    storagePath: true,
    fileSize: true,
    checksum: true,
    downloadedAt: true,
    lastDownloadError: true,
    url: true,
  },
});

const smokeVerified = sampleDocuments.some((document) => document.storageProvider === 'cloudflare-r2' && document.storageBucket && document.storagePath && document.downloadStatus === 'downloaded');
if (!smokeVerified) {
  failed++;
  errors.push('Storage smoke did not produce a verified Cloudflare R2 document record');
}

console.log(JSON.stringify({
  status: failed === 0 ? 'ok' : 'partial',
  sourceEndpoint: '/Home/PaginatedTenderOpportunities',
  recordsTotal: page.recordsTotal,
  attempted: page.releases.length,
  succeeded,
  failed,
  documentsDiscovered,
  documentsResolved,
  documentsDownloaded,
  storageSmokeVerified: smokeVerified,
  counts,
  sampleDocuments,
  errors,
}, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));

await db.$disconnect();
if (failed > 0) process.exit(1);
