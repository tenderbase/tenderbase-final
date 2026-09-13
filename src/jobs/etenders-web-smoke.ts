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
      // The live eTenders opportunity response exposes documentId but omits blobName.
      // Browser downloads use the document UUID plus the original file extension,
      // e.g. <uuid>.pdf or <uuid>.docx. Resolve that exact blob name before download.
      const missing = await db.document.findMany({
        where: { tenderId: result.tenderId, blobName: null },
        select: { id: true, documentId: true, downloadedFileName: true, title: true },
      });

      for (const document of missing) {
        if (!uuid.test(document.documentId)) continue;
        const filename = document.downloadedFileName ?? document.title ?? `${document.documentId}.bin`;
        const blobName = blobNameFor(document.documentId, filename);
        const url = `https://www.etenders.gov.za/home/Download/?blobName=${encodeURIComponent(blobName)}&downloadedFileName=${encodeURIComponent(filename)}`;

        await db.document.update({
          where: { id: document.id },
          data: {
            blobName,
            downloadedFileName: filename,
            url,
            downloadStatus: 'discovered',
            lastDownloadError: null,
          },
        });
        documentsResolved++;
      }

      const downloads = await downloadDiscoveredDocuments(result.tenderId);
      documentsDownloaded += downloads.length;
    }
  } catch (error) {
    failed++;
    errors.push(`${release.ocid}: ${error instanceof Error ? error.message : String(error)}`);
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
    storagePath: true,
    fileSize: true,
    checksum: true,
    downloadedAt: true,
    lastDownloadError: true,
    url: true,
  },
});

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
  counts,
  sampleDocuments,
  errors,
}, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));

await db.$disconnect();
if (failed > 0) process.exit(1);
