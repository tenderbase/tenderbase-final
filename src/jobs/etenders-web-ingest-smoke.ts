import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';
import { db } from '../db.js';

const client = new EtendersWebClient();
const length = Math.min(Math.max(Number(process.env.ETENDERS_SMOKE_LENGTH ?? 10), 1), 25);
const page = await client.getOpportunities({ length, status: 1 });

let succeeded = 0;
let failed = 0;
const errors: string[] = [];
for (const release of page.releases) {
  try {
    await persistRelease(release);
    succeeded++;
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
};

console.log(JSON.stringify({
  status: failed === 0 ? 'ok' : 'partial',
  sourceEndpoint: '/Home/PaginatedTenderOpportunities',
  recordsTotal: page.recordsTotal,
  attempted: page.releases.length,
  succeeded,
  failed,
  counts,
  errors,
}, null, 2));

await db.$disconnect();
if (failed > 0) process.exit(1);
