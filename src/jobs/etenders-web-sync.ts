import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';
import { db } from '../db.js';

function numberArg(name: string, fallback: number): number {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  return Number.isFinite(value) ? value : fallback;
}

function stringArg(name: string, fallback = ''): string {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

async function main() {
  const client = new EtendersWebClient();
  const pageLength = Math.min(Math.max(numberArg('length', 10), 1), 100);
  const maxReleases = Math.max(numberArg('max', pageLength), 1);
  const status = numberArg('status', 1);
  const search = stringArg('search');
  const province = stringArg('province');
  const organOfState = stringArg('organOfState');
  const category = stringArg('category');
  const tenderType = stringArg('tenderType');
  const eSubmission = stringArg('eSubmission');
  const dryRun = process.argv.includes('--dry-run');

  let fetched = 0;
  let persisted = 0;
  let failed = 0;

  console.log(JSON.stringify({ source: 'etenders-web', pageLength, maxReleases, status, search, province, organOfState, category, tenderType, eSubmission, dryRun }));

  try {
    for await (const page of client.iterate({ length: pageLength, status, search, province, organOfState, category, tenderType, eSubmission })) {
      for (const release of page.releases) {
        if (fetched >= maxReleases) break;
        fetched++;
        try {
          if (!dryRun) await persistRelease(release);
          persisted++;
        } catch (error) {
          failed++;
          console.error(`[etenders-web] persistence failed for ${release.ocid}:`, error);
        }
      }
      console.log(JSON.stringify({ draw: page.draw, recordsTotal: page.recordsTotal, recordsFiltered: page.recordsFiltered, pageRows: page.rows.length, fetched, persisted, failed }));
      if (fetched >= maxReleases) break;
    }

    if (fetched === 0) throw new Error('eTenders web feed returned zero rows');
    console.log(JSON.stringify({ status: 'completed', fetched, persisted, failed, dryRun }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error('[etenders-web] failed:', error);
  process.exit(1);
});
