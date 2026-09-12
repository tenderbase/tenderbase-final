import { z } from 'zod';
import type { Release, ReleasePackage } from './types.js';

const BASE_URL = (process.env.ETENDERS_BASE_URL ?? 'https://ocds-api.etenders.gov.za').replace(/\/$/, '');
const PAGE_SIZES = [20000, 10000, 5000, 1000];
const packageSchema = z.object({ releases: z.array(z.unknown()).optional(), links: z.record(z.string(), z.unknown()).optional() }).passthrough();

export interface ReleaseQuery { pageNumber: number; pageSize: number; dateFrom?: Date; dateTo?: Date }

function isoDate(value?: Date) { return value ? value.toISOString() : undefined; }
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export class EtendersClient {
  constructor(private readonly baseUrl = BASE_URL, private readonly timeoutMs = Number(process.env.ETENDERS_TIMEOUT_MS ?? 60000)) {}

  async getReleases(query: ReleaseQuery): Promise<ReleasePackage> {
    const url = new URL('/api/OCDSReleases', this.baseUrl);
    url.searchParams.set('PageNumber', String(query.pageNumber));
    url.searchParams.set('PageSize', String(query.pageSize));
    if (query.dateFrom) url.searchParams.set('dateFrom', isoDate(query.dateFrom)!);
    if (query.dateTo) url.searchParams.set('dateTo', isoDate(query.dateTo)!);

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'TenderBase/0.2 OCDS collector' } });
        if (response.ok) {
          const body = await response.json();
          const parsed = packageSchema.parse(body);
          return parsed as unknown as ReleasePackage;
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error(`eTenders HTTP ${response.status}: ${await response.text()}`);
        }
        lastError = new Error(`eTenders HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === 3) break;
      } finally { clearTimeout(timer); }
      await sleep(500 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async getPageWithFallback(pageNumber: number, dateFrom?: Date, dateTo?: Date) {
    let lastError: unknown;
    for (const pageSize of PAGE_SIZES) {
      try { return { pageSize, package: await this.getReleases({ pageNumber, pageSize, dateFrom, dateTo }) }; }
      catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async *iterate(dateFrom: Date, dateTo: Date) {
    let page = 1;
    let chosenPageSize: number | undefined;
    while (true) {
      const result = await this.getPageWithFallback(page, dateFrom, dateTo);
      chosenPageSize = chosenPageSize ?? result.pageSize;
      const releases = result.package.releases ?? [];
      yield { page, pageSize: result.pageSize, releases, package: result.package };
      if (releases.length === 0 || releases.length < result.pageSize) break;
      page++;
    }
  }
}

export { BASE_URL, PAGE_SIZES };
