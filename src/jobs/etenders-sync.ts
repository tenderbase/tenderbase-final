import { db } from '../db.js';
import { EtendersClient } from '../collectors/etenders/client.js';
import { persistRelease } from '../collectors/etenders/importer.js';

const arg = (name: string) => { const hit = process.argv.find(x => x.startsWith(`--${name}=`)); return hit?.split('=')[1]; };
const days = Number(arg('days') ?? 0);
const hours = Number(arg('hours') ?? 0);
const now = new Date();
const dateFrom = new Date(now.getTime() - (days ? days * 86400000 : hours ? hours * 3600000 : 86400000));
const dateTo = now;

async function main() {
  const run = await db.ingestionRun.create({ data: { source: 'etenders-ocds', dateFrom, dateTo, metadata: { mode: days ? 'backfill' : 'sync' } } });
  const client = new EtendersClient();
  let pages = 0, releases = 0, succeeded = 0, failed = 0, pageSize: number | undefined;
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
    console.log(JSON.stringify({ runId: run.id, status: failed ? 'completed_with_errors' : 'completed', pages, releases, succeeded, failed, pageSize }));
  } catch (error) {
    await db.ingestionRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: 'failed', error: error instanceof Error ? error.message : String(error), pages, releases, succeeded, failed, pageSize } });
    throw error;
  } finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exit(1); });
