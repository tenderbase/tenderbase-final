import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';

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

export async function runSync(options: {
  pageLength?: number;
  maxReleases?: number;
  status?: number;
  search?: string;
  province?: string;
  organOfState?: string;
  category?: string;
  tenderType?: string;
  eSubmission?: string;
  dryRun?: boolean;
} = {}) {
  const client = new EtendersWebClient();
  const pageLength = Math.min(Math.max(options.pageLength ?? numberArg('length', 10), 1), 100);
  const maxReleases = Math.max(options.maxReleases ?? numberArg('max', pageLength), 1);
  const status = options.status ?? numberArg('status', 1);
  const search = options.search ?? stringArg('search');
  const province = options.province ?? stringArg('province');
  const organOfState = options.organOfState ?? stringArg('organOfState');
  const category = options.category ?? stringArg('category');
  const tenderType = options.tenderType ?? stringArg('tenderType');
  const eSubmission = options.eSubmission ?? stringArg('eSubmission');
  const dryRun = options.dryRun ?? process.argv.includes('--dry-run');

  let fetched = 0;
  let persisted = 0;
  let failed = 0;

  console.log(JSON.stringify({ source: 'etenders-web', pageLength, maxReleases, status, search, province, organOfState, category, tenderType, eSubmission, dryRun }));

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
  return { status: 'completed', fetched, persisted, failed, dryRun } as const;
}
