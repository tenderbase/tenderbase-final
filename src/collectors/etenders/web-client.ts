import { z } from 'zod';
import type { Release, Tender } from './types.js';

const BASE_URL = (process.env.ETENDERS_WEB_BASE_URL ?? 'https://www.etenders.gov.za').replace(/\/$/, '');
const ENDPOINT = '/Home/PaginatedTenderOpportunities';

const rowSchema = z.record(z.string(), z.unknown());
const responseSchema = z.object({
  draw: z.number().optional(),
  recordsTotal: z.number().optional(),
  recordsFiltered: z.number().optional(),
  data: z.array(rowSchema),
}).passthrough();

export interface WebOpportunityQuery {
  start?: number;
  length?: number;
  status?: number;
  search?: string;
  province?: string;
  organOfState?: string;
  category?: string;
  tenderType?: string;
  eSubmission?: string;
}

function clean(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function asRelease(row: Record<string, unknown>): Release {
  const tender: Tender = {
    id: clean(row.tenderNumber ?? row.tenderNo ?? row.referenceNumber ?? row.id),
    title: clean(row.description ?? row.title ?? row.tenderDescription),
    description: clean(row.description ?? row.title),
    category: clean(row.category),
    province: clean(row.province),
    status: clean(row.status),
    procurementMethodDetails: clean(row.tenderType ?? row.procurementMethod),
    submissionMethodDetails: clean(row.eSubmission),
    tenderPeriod: {
      startDate: clean(row.date_Published ?? row.datePublished ?? row.publishedDate),
      endDate: clean(row.closing_Date ?? row.closingDate ?? row.closeDate),
    },
  };

  const id = clean(row.id ?? row.tenderNumber ?? row.tenderNo ?? row.referenceNumber);
  const ocid = clean(row.ocid) ?? (id ? `etenders-${id}` : `etenders-row-${Date.now()}`);

  return {
    ocid,
    id: `${ocid}-release`,
    date: clean(row.date_Published ?? row.datePublished ?? row.publishedDate),
    description: clean(row.description ?? row.title),
    tender,
    buyer: row.buyer && typeof row.buyer === 'object' ? row.buyer as Record<string, unknown> : undefined,
  };
}

export class EtendersWebClient {
  constructor(
    private readonly baseUrl = BASE_URL,
    private readonly timeoutMs = Number(process.env.ETENDERS_WEB_TIMEOUT_MS ?? 30000),
  ) {}

  async getOpportunities(query: WebOpportunityQuery = {}) {
    const url = new URL(ENDPOINT, this.baseUrl);
    const params: Record<string, string> = {
      draw: '1',
      start: String(query.start ?? 0),
      length: String(Math.min(query.length ?? 100, 100)),
      status: String(query.status ?? 1),
      'search[value]': query.search ?? '',
      'search[regex]': 'false',
      _: String(Date.now()),
    };

    if (query.province) params.province = query.province;
    if (query.organOfState) params.organOfState = query.organOfState;
    if (query.category) params.category = query.category;
    if (query.tenderType) params.tenderType = query.tenderType;
    if (query.eSubmission) params.eSubmission = query.eSubmission;

    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          'user-agent': 'TenderBase/1.0 eTenders web collector',
          'x-requested-with': 'XMLHttpRequest',
          referer: `${this.baseUrl}/Home/opportunities?id=1`,
        },
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`eTenders web HTTP ${response.status} at ${url}: ${body.slice(0, 500)}`);
      const parsed = responseSchema.parse(JSON.parse(body));
      return {
        draw: parsed.draw,
        recordsTotal: parsed.recordsTotal ?? 0,
        recordsFiltered: parsed.recordsFiltered ?? 0,
        rows: parsed.data,
        releases: parsed.data.map(asRelease),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *iterate(query: Omit<WebOpportunityQuery, 'start'> = {}) {
    const length = Math.min(query.length ?? 100, 100);
    let start = 0;
    while (true) {
      const page = await this.getOpportunities({ ...query, start, length });
      yield page;
      if (!page.rows.length || page.rows.length < length) break;
      start += length;
      if (page.recordsFiltered && start >= page.recordsFiltered) break;
    }
  }
}

export { BASE_URL, ENDPOINT };
