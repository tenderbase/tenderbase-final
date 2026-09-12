import { createServer } from 'node:http';
import { db } from '../db.js';
import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';

// TenderBase uses the official eTenders website scraper as its source of truth.
// The OCDS/API integration is intentionally not used by this worker.
const port = Number(process.env.PORT ?? 10000);
const healthServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ingesting', service: 'etenders-scraper' }));
});
healthServer.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ service: 'etenders-scraper', healthPort: port, status: 'ready' }));
});

const arg = (name: string) => {
  const hit = process.argv.find(x => x.startsWith(`--${name}=`));
  return hit?.split('=')[1];
};

const days = Number(arg('days') ?? 0);
const hours = Number(arg('hours') ?? 0);
const now = new Date();
const dateFrom = new Date(now.getTime() - (days ? days * 86400000 : hours ? hours * 3600000 : 86400000));
const dateTo = now;

function parsedDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

async function runScraper(runId: string) {
  const client = new EtendersWebClient();
  // Status 1 is currently advertised/new tenders. The other feeds are scraped
  // too so the database also receives lifecycle changes. Upserts make repeats safe.
  const statuses = [1, 2, 3, 4];
  let pages = 0, releases = 0, succeeded = 0, failed = 0;

  console.log(JSON.stringify({ source: 'etenders-web-scraper', dateFrom, dateTo, statuses, batchSize: 10, mode: days ? 'backfill' : 'poll' }));

  for (const status of statuses) {
    let statusPages = 0;
    for await (const page of client.iterate({ length: 100, status })) {
      pages++;
      statusPages++;
      const pageDates: number[] = [];
      const candidates: Array<{ release: typeof page.releases[number]; releaseDate: Date }> = [];

      for (let i = 0; i < page.releases.length; i++) {
        const release = page.releases[i];
        const row = page.rows[i] ?? {};
        const releaseDate = parsedDate(release.date) ?? parsedDate(row.date_Published ?? row.datePublished ?? row.publishedDate);
        if (releaseDate) pageDates.push(releaseDate.getTime());
        if (!releaseDate || releaseDate < dateFrom || releaseDate > dateTo) continue;
        candidates.push({ release, releaseDate });
      }

      for (let offset = 0; offset < candidates.length; offset += 10) {
        const batch = candidates.slice(offset, offset + 10);
        await Promise.all(batch.map(async ({ release }) => {
          releases++;
          try {
            await persistRelease(release);
            succeeded++;
          } catch (error) {
            failed++;
            await db.ingestionError.create({
              data: {
                ingestionRunId: runId,
                endpoint: '/Home/PaginatedTenderOpportunities',
                page: statusPages,
                releaseId: release.id,
                message: error instanceof Error ? error.message : String(error),
                payload: release as any,
              },
            });
          }
        }));
      }

      await db.ingestionRun.update({
        where: { id: runId },
        data: { pages, releases, succeeded, failed, checkpoint: status * 100000 + statusPages, pageSize: 100 },
      });

      console.log(JSON.stringify({
        mode: 'etenders-web-scraper', status, page: statusPages,
        recordsTotal: page.recordsTotal, pageRows: page.rows.length,
        matched: candidates.length, releases, succeeded, failed,
        oldest: pageDates.length ? new Date(Math.min(...pageDates)).toISOString() : null,
        newest: pageDates.length ? new Date(Math.max(...pageDates)).toISOString() : null,
      }));

      if (page.rows.length === 0 || page.rows.length < 100) break;
      // The feed is newest-first; stop once a page is completely older than our window.
      if (pageDates.length > 0 && Math.max(...pageDates) < dateFrom.getTime()) break;
    }
  }

  return { pages, releases, succeeded, failed };
}

async function main() {
  const run = await db.ingestionRun.create({
    data: {
      source: 'etenders-web',
      dateFrom,
      dateTo,
      metadata: { mode: days ? 'backfill' : 'poll', source: 'official-etenders-website-scraper', apiDisabled: true },
    },
  });

  let result = { pages: 0, releases: 0, succeeded: 0, failed: 0 };
  try {
    result = await runScraper(run.id);
    await db.ingestionRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: result.failed ? 'completed_with_errors' : 'completed', ...result, pageSize: 100, error: null },
    });
    console.log(JSON.stringify({ runId: run.id, status: result.failed ? 'completed_with_errors' : 'completed', ...result, source: 'etenders-web-scraper' }));
  } catch (error) {
    await db.ingestionRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'failed', error: error instanceof Error ? error.message : String(error), ...result, pageSize: 100 },
    });
    throw error;
  } finally {
    healthServer.close();
    await db.$disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
