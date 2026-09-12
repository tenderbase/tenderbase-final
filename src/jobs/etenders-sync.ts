import { db } from '../db.js';
import { EtendersClient } from '../collectors/etenders/client.js';
import { EtendersWebClient } from '../collectors/etenders/web-client.js';
import { persistRelease } from '../collectors/etenders/importer.js';

const arg = (name: string) => { const hit = process.argv.find(x => x.startsWith(`--${name}=`)); return hit?.split('=')[1]; };
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

async function runWebFallback(runId: string) {
  const client = new EtendersWebClient();
  const statuses = [1, 2, 3, 4];
  let pages = 0, releases = 0, succeeded = 0, failed = 0;

  console.log(JSON.stringify({ source: 'etenders-web-fallback', dateFrom, dateTo, statuses }));

  for (const status of statuses) {
    let statusPages = 0;
    for await (const page of client.iterate({ length: 100, status })) {
      pages++; statusPages++;
      const pageDates: number[] = [];

      for (let i = 0; i < page.releases.length; i++) {
        const release = page.releases[i];
        const row = page.rows[i] ?? {};
        const releaseDate = parsedDate(release.date) ?? parsedDate(row.date_Published ?? row.datePublished ?? row.publishedDate);
        if (releaseDate) pageDates.push(releaseDate.getTime());
        if (!releaseDate || releaseDate < dateFrom || releaseDate > dateTo) continue;

        releases++;
        try {
          await persistRelease(release);
          succeeded++;
        } catch (error) {
          failed++;
          await db.ingestionError.create({ data: { ingestionRunId: runId, endpoint: '/Home/PaginatedTenderOpportunities', page: statusPages, releaseId: release.id, message: error instanceof Error ? error.message : String(error), payload: release as any } });
        }
      }

      await db.ingestionRun.update({ where: { id: runId }, data: { pages, releases, succeeded, failed, checkpoint: `${status}:${statusPages}`, pageSize: 100 } });
      console.log(JSON.stringify({ mode: 'web-fallback', status, page: statusPages, recordsTotal: page.recordsTotal, pageRows: page.rows.length, releases, succeeded, failed, oldest: pageDates.length ? new Date(Math.min(...pageDates)).toISOString() : null, newest: pageDates.length ? new Date(Math.max(...pageDates)).toISOString() : null }));

      if (page.rows.length === 0 || page.rows.length < 100) break;
      if (pageDates.length > 0 && Math.max(...pageDates) < dateFrom.getTime()) break;
    }
  }

  return { pages, releases, succeeded, failed };
}

async function main() {
  const run = await db.ingestionRun.create({ data: { source: 'etenders-ocds', dateFrom, dateTo, metadata: { mode: days ? 'backfill' : 'sync' } } });
  const client = new EtendersClient();
  let pages = 0, releases = 0, succeeded = 0, failed = 0, pageSize: number | undefined;
  try {
    try {
      for await (const page of client.iterate(dateFrom, dateTo)) {
        pages++; pageSize = page.pageSize; releases += page.releases.length;
        for (const release of page.releases) {
          try { await persistRelease(release); succeeded++; }
          catch (error) {
            failed++;
            await db.ingestionError.create({ data: { ingestionRunId: run.id, endpoint: '/api/OCDSReleases', page: page.page, releaseId: release.id, message: error instanceof Error ? error.message : String(error), payload: release as any } });
          }
        }
        await db.ingestionRun.update({ where: { id: run.id }, data: { pages, releases, succeeded, failed, pageSize, checkpoint: page.page } });
        await db.ingestionCheckpoint.upsert({ where: { source: 'etenders-ocds' }, create: { source: 'etenders-ocds', pageNumber: page.page, dateFrom, dateTo, lastReleaseDate: page.releases.at(-1)?.date ? new Date(page.releases.at(-1)!.date!) : undefined }, update: { pageNumber: page.page, dateFrom, dateTo, lastReleaseDate: page.releases.at(-1)?.date ? new Date(page.releases.at(-1)!.date!) : undefined } });
      }
      await db.ingestionRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: failed ? 'completed_with_errors' : 'completed', pages, releases, succeeded, failed, pageSize } });
      console.log(JSON.stringify({ runId: run.id, status: failed ? 'completed_with_errors' : 'completed', pages, releases, succeeded, failed, pageSize, source: 'etenders-ocds' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('eTenders HTTP 404')) throw error;
      console.warn('[etenders-sync] OCDS API is returning 404; switching to official eTenders web status feeds for the requested window.');
      const fallback = await runWebFallback(run.id);
      await db.ingestionRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: fallback.failed ? 'completed_with_errors' : 'completed', pages: fallback.pages, releases: fallback.releases, succeeded: fallback.succeeded, failed: fallback.failed, pageSize: 100, error: null } });
      console.log(JSON.stringify({ runId: run.id, status: fallback.failed ? 'completed_with_errors' : 'completed', ...fallback, source: 'etenders-web-fallback' }));
    }
  } catch (error) {
    await db.ingestionRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: 'failed', error: error instanceof Error ? error.message : String(error), pages, releases, succeeded, failed, pageSize } });
    throw error;
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exit(1); });
