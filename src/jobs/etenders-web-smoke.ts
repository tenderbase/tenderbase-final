import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';
import { runSync } from './etenders-web-sync.js';
import { db } from '../db.js';

const fullSync = process.env.ETENDERS_RUN_FULL_SYNC === 'true';

if (fullSync) {
  try {
    const result = await runSync({
      pageLength: 100,
      maxReleases: Number(process.env.ETENDERS_FULL_SYNC_MAX ?? 10000),
      status: 1,
    });
    console.log(JSON.stringify({ mode: 'full-sync', ...result, counts: {
      tenders: await db.tender.count(),
      releases: await db.release.count(),
      sourceRecords: await db.sourceRecord.count(),
      organizations: await db.organization.count(),
      awards: await db.award.count(),
      contracts: await db.contract.count(),
    }}));
  } finally {
    await db.$disconnect();
  }
  process.exit(0);
}

const client = new EtendersWebClient();
const length = Math.min(Math.max(Number(process.env.ETENDERS_SMOKE_LENGTH ?? 10), 1), 100);
const page = await client.getOpportunities({ length, status: 1 });

let persisted = 0;
let failed = 0;
const errors: string[] = [];

if (process.env.DATABASE_URL) {
  for (const release of page.releases) {
    try {
      await persistRelease(release);
      persisted++;
    } catch (error) {
      failed++;
      errors.push(`${release.ocid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const result: Record<string, unknown> = {
  status: failed === 0 ? 'ok' : 'partial',
  endpoint: '/Home/PaginatedTenderOpportunities',
  recordsTotal: page.recordsTotal,
  recordsFiltered: page.recordsFiltered,
  rows: page.rows.length,
  persisted,
  failed,
  sample: page.releases.slice(0, 3).map((release) => ({
    ocid: release.ocid,
    title: release.tender?.title,
    published: release.date,
    closing: release.tender?.tenderPeriod?.endDate,
    province: release.tender?.province,
    buyer: release.buyer,
  })),
  errors,
};

if (process.env.DATABASE_URL) {
  result.counts = {
    tenders: await db.tender.count(),
    releases: await db.release.count(),
    sourceRecords: await db.sourceRecord.count(),
    organizations: await db.organization.count(),
    awards: await db.award.count(),
    contracts: await db.contract.count(),
  };
  await db.$disconnect();
}

console.log(JSON.stringify(result));
if (failed > 0) process.exit(1);
