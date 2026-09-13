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
let documentsDownloaded = 0;
const errors: string[] = [];

for (const release of page.releases) {
  try {
    const result = await persistRelease(release);
    succeeded++;
    documentsDiscovered += result.documents ?? 0;

    if (result.normalized && result.tenderId && result.downloadableDocuments) {
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
  documentsDownloaded,
  counts,
  sampleDocuments,
  errors,
}, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));

await db.$disconnect();
if (failed > 0) process.exit(1);
