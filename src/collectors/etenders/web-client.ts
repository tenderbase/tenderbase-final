import { z } from 'zod';
import type { JsonObject, Party, Release, Tender, Document } from './types.js';

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

function classifyTenderType(...values: Array<unknown>): string | undefined {
  const text = values.map(clean).filter(Boolean).join(' ').toUpperCase();
  if (!text) return undefined;
  if (/\b(RFQ|REQUEST FOR QUOTATION|REQUEST FOR QUOTES)\b/.test(text)) return 'RFQ';
  if (/\b(RFP|REQUEST FOR PROPOSAL|REQUEST FOR PROPOSALS)\b/.test(text)) return 'RFP';
  if (/\b(ITT|INVITATION TO TENDER|INVITATION FOR TENDERS)\b/.test(text)) return 'ITT';
  if (/\b(EOI|EXPRESSION OF INTEREST)\b/.test(text)) return 'EOI';
  return undefined;
}

function partyFromValue(value: unknown, fallbackPrefix: string): Party | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const id = clean(raw.id ?? raw.identifier ?? raw.code);
    const name = clean(raw.name ?? raw.legalName ?? raw.description ?? raw.title);
    if (!id && !name) return undefined;
    return {
      id: id ?? `${fallbackPrefix}-${name!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      name,
      identifier: typeof raw.identifier === 'object' && raw.identifier ? raw.identifier as JsonObject : undefined,
      address: typeof raw.address === 'object' && raw.address ? raw.address as JsonObject : undefined,
      contactPoint: typeof raw.contactPoint === 'object' && raw.contactPoint ? raw.contactPoint as JsonObject : undefined,
    };
  }
  const name = clean(value);
  if (!name) return undefined;
  return { id: `${fallbackPrefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, name };
}

function rowParty(row: Record<string, unknown>, prefix: string): Party | undefined {
  const candidates = prefix === 'buyer'
    ? [row.buyer, row.buyerName, row.buyer_name, row.organOfState, row.organOfStateName, row.organ_of_state, row.department, row.departmentName, row.institution, row.institutionName]
    : [row.procuringEntity, row.procuringEntityName, row.procuring_entity, row.organOfState, row.organOfStateName, row.organ_of_state, row.department, row.departmentName, row.institution, row.institutionName];
  for (const candidate of candidates) {
    const party = partyFromValue(candidate, prefix);
    if (party) return party;
  }
  return undefined;
}

const DOCUMENT_CONTAINER_KEYS = new Set(['documents', 'document', 'supportdocuments', 'supportdocument', 'supportdocumentlist', 'supportdocumentfiles', 'attachments', 'files']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function extractDocuments(row: Record<string, unknown>): Document[] {
  const found = new Map<string, Document>();
  const visited = new Set<object>();

  const visit = (value: unknown, hint?: string) => {
    if (!value || typeof value !== 'object') return;
    if (visited.has(value as object)) return;
    visited.add(value as object);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, hint);
      return;
    }

    const raw = value as Record<string, unknown>;
    const entries = Object.entries(raw);
    const keyMap = new Map(entries.map(([key, val]) => [normalKey(key), val]));
    const blobName = clean(keyMap.get('blobname') ?? keyMap.get('blob') ?? keyMap.get('blobfilename'));
    const downloadedFileName = clean(keyMap.get('downloadedfilename') ?? keyMap.get('filename') ?? keyMap.get('originalfilename') ?? keyMap.get('documentname') ?? keyMap.get('name'));
    const supportDocumentId = clean(keyMap.get('supportdocumentid') ?? keyMap.get('supportdocumentidvalue'));
    const url = clean(keyMap.get('url') ?? keyMap.get('documenturl') ?? keyMap.get('downloadurl'));
    const title = clean(keyMap.get('title') ?? keyMap.get('description') ?? downloadedFileName);
    const format = clean(keyMap.get('format') ?? keyMap.get('mimetype') ?? keyMap.get('contenttype'));

    if (blobName || supportDocumentId || (url && (hint === 'document' || hint === 'supportdocument'))) {
      const id = supportDocumentId ?? blobName ?? url;
      if (id) {
        found.set(id, {
          id,
          documentType: clean(keyMap.get('documenttype') ?? keyMap.get('type')),
          title,
          description: clean(keyMap.get('description')),
          format,
          url: url ?? (blobName ? `${BASE_URL}/home/Download/?blobName=${encodeURIComponent(blobName)}&downloadedFileName=${encodeURIComponent(downloadedFileName ?? blobName)}` : undefined),
          datePublished: clean(keyMap.get('datepublished') ?? keyMap.get('publisheddate')),
          dateModified: clean(keyMap.get('datemodified') ?? keyMap.get('modifieddate')),
          supportDocumentId,
          blobName,
          downloadedFileName: downloadedFileName ?? blobName,
        });
      }
    }

    for (const [key, child] of entries) {
      const normalized = normalKey(key);
      const childHint = DOCUMENT_CONTAINER_KEYS.has(normalized) ? normalized : hint;
      if (DOCUMENT_CONTAINER_KEYS.has(normalized) || normalized.includes('document')) visit(child, childHint);
      else if (isRecord(child) || Array.isArray(child)) visit(child, childHint);
    }
  };

  visit(row);
  return [...found.values()];
}

function asRelease(row: Record<string, unknown>): Release {
  const buyer = rowParty(row, 'buyer');
  const procuringEntity = rowParty(row, 'procuring');
  const title = clean(row.description ?? row.title ?? row.tenderDescription);
  const description = clean(row.description ?? row.title);
  const explicitTenderType = clean(row.tenderType ?? row.tender_type ?? row.procurementMethod);
  const tenderType = explicitTenderType ?? classifyTenderType(title, description);
  const documents = extractDocuments(row);
  const tender: Tender = {
    id: clean(row.tenderNumber ?? row.tenderNo ?? row.referenceNumber ?? row.id),
    title,
    description,
    category: clean(row.category),
    province: clean(row.province),
    status: clean(row.status),
    procurementMethodDetails: tenderType,
    submissionMethodDetails: clean(row.eSubmission),
    tenderPeriod: {
      startDate: clean(row.date_Published ?? row.datePublished ?? row.publishedDate),
      endDate: clean(row.closing_Date ?? row.closingDate ?? row.closeDate),
    },
    documents,
    procuringEntity: procuringEntity as JsonObject | undefined,
  };

  const id = clean(row.id ?? row.tenderNumber ?? row.tenderNo ?? row.referenceNumber);
  const ocid = clean(row.ocid) ?? (id ? `etenders-${id}` : `etenders-row-${Date.now()}`);

  return {
    ocid,
    id: `${ocid}-release`,
    date: clean(row.date_Published ?? row.datePublished ?? row.publishedDate),
    description,
    tender,
    buyer: buyer as JsonObject | undefined,
    parties: [buyer, procuringEntity].filter(Boolean) as Party[],
    sourceRow: row,
  };
}

export class EtendersWebClient {
  constructor(
    private readonly baseUrl = BASE_URL,
    private readonly timeoutMs = Number(process.env.ETENDERS_WEB_TIMEOUT_MS ?? 30000),
    private readonly maxRetries = Number(process.env.ETENDERS_WEB_MAX_RETRIES ?? 4),
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

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
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
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries) throw error;
        const delay = Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        console.warn(`[etenders-web] request failed (attempt ${attempt + 1}/${this.maxRetries + 1}); retrying in ${delay}ms`, error instanceof Error ? error.message : String(error));
        await new Promise(resolve => setTimeout(resolve, delay));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

export { BASE_URL, ENDPOINT, extractDocuments };
