import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function arg(name: string, fallback: number) {
  const raw = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const n = Number(raw.slice(name.length + 3));
  return Number.isFinite(n) ? n : fallback;
}

function parseDate(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const days = Math.max(1, arg('days', 30));
  const length = Math.min(100, Math.max(1, arg('length', 100)));
  const maxPerStatus = Math.max(1, arg('maxPerStatus', 20000));
  const cutoff = Date.now() - days * DAY_MS;
  const client = new EtendersWebClient();
  const statuses = [1, 2, 3, 4];

  let totalFetched = 0;
  let totalPersisted = 0;
  let totalFailed = 0;

  console.log(JSON.stringify({ source: 'etenders-web-historical', days, cutoff: new Date(cutoff).toISOString(), statuses, length }));

  for (const status of statuses) {
    let seen = 0;
    let persisted = 0;
    let failed = 0;
    let pages = 0;

    for await (const page of client.iterate({ length, status })) {
      pages++;
      let pageDates: number[] = [];

      for (let i = 0; i < page.releases.length; i++) {
        const release = page.releases[i];
        const row = page.rows[i] ?? {};
        const releaseDate = parseDate(release.date) ?? parseDate(row.date_Published ?? row.datePublished ?? row.publishedDate);
        if (releaseDate !== undefined) pageDates.push(releaseDate);

        // Only import tenders published in the requested window. The source feeds
        // are ordered newest-first; once an entire page is older than the cutoff,
        // we can stop paging that status without walking its full historical table.
        if (releaseDate === undefined || releaseDate < cutoff || releaseDate > Date.now()) continue;
        if (seen >= maxPerStatus) break;

        seen++;
        totalFetched++;
        try {
          await persistRelease(release);
          persisted++;
          totalPersisted++;
        } catch (error) {
          failed++;
          totalFailed++;
          console.error(`[etenders-web-historical] persistence failed for ${release.ocid}:`, error);
        }
      }

      const newest = pageDates.length ? Math.max(...pageDates) : undefined;
      const oldest = pageDates.length ? Math.min(...pageDates) : undefined;
      console.log(JSON.stringify({ status, page: pages, recordsTotal: page.recordsTotal, pageRows: page.rows.length, windowFetched: seen, windowPersisted: persisted, windowFailed: failed, oldest: oldest ? new Date(oldest).toISOString() : null, newest: newest ? new Date(newest).toISOString() : null }));

      if (seen >= maxPerStatus) break;
      if (page.rows.length === 0 || page.rows.length < length) break;
      if (pageDates.length > 0 && oldest! < cutoff && newest! < cutoff) break;
    }
  }

  console.log(JSON.stringify({ status: 'completed', totalFetched, totalPersisted, totalFailed, days }));
  if (totalFetched === 0) throw new Error('No eTenders records matched the historical web window');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
