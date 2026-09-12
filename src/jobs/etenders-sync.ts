import { createServer } from 'node:http';
import { db } from '../db.js';
import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';

// Official eTenders website scraper is the sole TenderBase ingestion source.
const port = Number(process.env.PORT ?? 10000);
const healthServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ingesting', service: 'etenders-scraper' }));
});
healthServer.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'etenders-scraper', healthPort: port, status: 'ready' })));

const arg = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.split('=')[1];
const initialDays = Number(arg('days') ?? 30);
const pollMinutes = Math.max(1, Number(process.env.ETENDERS_POLL_MINUTES ?? 15));

function parsedDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

type ScrapeResult = { pages: number; releases: number; succeeded: number; failed: number };

async function scrapeWindow(runId: string, dateFrom: Date, dateTo: Date, statuses: number[], mode: string): Promise<ScrapeResult> {
  const client = new EtendersWebClient();
  let pages = 0, releases = 0, succeeded = 0, failed = 0;
  console.log(JSON.stringify({ source: 'etenders-web-scraper', dateFrom, dateTo, statuses, mode, batchSize: 10 }));

  for (const status of statuses) {
    let statusPages = 0;
    let start = 0;
    const length = 100;

    // Fetch pages explicitly so an isolated upstream HTTP 500 does not abort
    // every other status/feed. The failed page is recorded and this status is
    // skipped; the next status can still complete and the next poll retries it.
    while (true) {
      let page;
      try {
        page = await client.getOpportunities({ start, length, status });
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ mode, status, page: statusPages + 1, start, error: message, action: 'skip-page-and-continue' }));
        await db.ingestionError.create({ data: {
          ingestionRunId: runId,
          endpoint: '/Home/PaginatedTenderOpportunities',
          page: statusPages + 1,
          message,
          payload: { status, start, length, mode } as any,
        }});
        break;
      }

      pages++; statusPages++;
      const pageDates: number[] = [];
      const candidates: Array<{ release: typeof page.releases[number]; releaseDate: Date }> = [];
      for (let i = 0; i < page.releases.length; i++) {
        const release = page.releases[i];
        const row = page.rows[i] ?? {};
        const releaseDate = parsedDate(release.date) ?? parsedDate(row.date_Published ?? row.datePublished ?? row.publishedDate);
        if (releaseDate) pageDates.push(releaseDate.getTime());
        if (releaseDate && releaseDate >= dateFrom && releaseDate <= dateTo) candidates.push({ release, releaseDate });
      }

      for (let offset = 0; offset < candidates.length; offset += 10) {
        await Promise.all(candidates.slice(offset, offset + 10).map(async ({ release }) => {
          releases++;
          try { await persistRelease(release); succeeded++; }
          catch (error) {
            failed++;
            await db.ingestionError.create({ data: {
              ingestionRunId: runId,
              endpoint: '/Home/PaginatedTenderOpportunities',
              page: statusPages,
              releaseId: release.id,
              message: error instanceof Error ? error.message : String(error),
              payload: release as any,
            }});
          }
        }));
      }

      await db.ingestionRun.update({ where: { id: runId }, data: {
        pages, releases, succeeded, failed,
        checkpoint: status * 100000 + statusPages,
        pageSize: 100,
      }});
      console.log(JSON.stringify({ mode, status, page: statusPages, recordsTotal: page.recordsTotal, pageRows: page.rows.length, matched: candidates.length, releases, succeeded, failed,
        oldest: pageDates.length ? new Date(Math.min(...pageDates)).toISOString() : null,
        newest: pageDates.length ? new Date(Math.max(...pageDates)).toISOString() : null }));

      if (page.rows.length === 0 || page.rows.length < length) break;
      if (pageDates.length > 0 && Math.max(...pageDates) < dateFrom.getTime()) break;
      if (page.recordsFiltered && start + length >= page.recordsFiltered) break;
      start += length;
    }
  }
  return { pages, releases, succeeded, failed };
}

async function executeRun(dateFrom: Date, dateTo: Date, statuses: number[], mode: string) {
  const run = await db.ingestionRun.create({ data: {
    source: 'etenders-web', dateFrom, dateTo,
    metadata: { mode, source: 'official-etenders-website-scraper', apiDisabled: true, statuses },
  }});
  let result: ScrapeResult = { pages: 0, releases: 0, succeeded: 0, failed: 0 };
  try {
    result = await scrapeWindow(run.id, dateFrom, dateTo, statuses, mode);
    await db.ingestionRun.update({ where: { id: run.id }, data: {
      finishedAt: new Date(), status: result.failed ? 'completed_with_errors' : 'completed', ...result, pageSize: 100, error: null,
    }});
    console.log(JSON.stringify({ runId: run.id, status: result.failed ? 'completed_with_errors' : 'completed', ...result, source: 'etenders-web-scraper', mode }));
    return result;
  } catch (error) {
    await db.ingestionRun.update({ where: { id: run.id }, data: {
      finishedAt: new Date(), status: 'failed', error: error instanceof Error ? error.message : String(error), ...result, pageSize: 100,
    }});
    throw error;
  }
}

async function main() {
  try {
    // One initial 30-day database fill, using all lifecycle feeds.
    const firstTo = new Date();
    const firstFrom = new Date(firstTo.getTime() - initialDays * 86400000);
    await executeRun(firstFrom, firstTo, [1, 2, 3, 4], 'initial-backfill');

    // Keep the database fresh forever. Only status 1 is polled because it is
    // the currently-advertised/new-tender feed. Every poll gets its own run.
    while (true) {
      const to = new Date();
      const from = new Date(to.getTime() - Math.max(pollMinutes * 2, 60) * 60000);
      try {
        await executeRun(from, to, [1], 'new-tender-poll');
      } catch (error) {
        console.error('[etenders-scraper] poll failed; will retry', error);
      }
      await new Promise(resolve => setTimeout(resolve, pollMinutes * 60000));
    }
  } finally {
    healthServer.close();
    await db.$disconnect();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
