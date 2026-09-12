import Fastify from 'fastify';
import { db } from './db.js';

const app = Fastify({ logger: true });

const apiInfo = {
  title: 'TenderBase API',
  version: '1.0.0',
  description: 'Database-backed South African public tender API. Data is ingested from the official eTenders website by TenderBase and served from Neon PostgreSQL.'
};

const schemas = {
  Error: { type: 'object', properties: { error: { type: 'string' } } },
  Pagination: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, pages: { type: 'integer' } } },
  Tender: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, ocid: { type: 'string' }, title: { type: ['string', 'null'] }, status: { type: ['string', 'null'] }, province: { type: ['string', 'null'] }, publishedDate: { type: ['string', 'null'], format: 'date-time' }, closingDate: { type: ['string', 'null'], format: 'date-time' } } }
};

const openapi = {
  openapi: '3.0.3',
  info: apiInfo,
  servers: [{ url: '/'}],
  tags: [
    { name: 'System' }, { name: 'Tenders' }, { name: 'OCDS' }, { name: 'Buyers' },
    { name: 'Suppliers' }, { name: 'Awards' }, { name: 'Statistics' }
  ],
  components: { schemas, parameters: {
    Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
    Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }
  }},
  paths: {
    '/': { get: { tags: ['System'], summary: 'API status', responses: { '200': { description: 'OK' } } } },
    '/health': { get: { tags: ['System'], summary: 'Health check including database connectivity', responses: { '200': { description: 'Healthy' }, '503': { description: 'Unavailable' } } } },
    '/openapi.json': { get: { tags: ['System'], summary: 'OpenAPI specification', responses: { '200': { description: 'OpenAPI document' } } } },
    '/docs': { get: { tags: ['System'], summary: 'Documentation metadata', responses: { '200': { description: 'Documentation metadata' } } } },
    '/api/v1/tenders': { get: { tags: ['Tenders'], summary: 'List tenders', parameters: [
      { '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' },
      { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string' } },
      { name: 'province', in: 'query', schema: { type: 'string' } }, { name: 'category', in: 'query', schema: { type: 'string' } },
      { name: 'buyerId', in: 'query', schema: { type: 'string' } }, { name: 'publishedFrom', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'publishedTo', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'closingBefore', in: 'query', schema: { type: 'string', format: 'date-time' } }
    ], responses: { '200': { description: 'Paginated tenders' } } } },
    '/api/v1/tenders/search': { get: { tags: ['Tenders'], summary: 'Full-text style tender search', parameters: [
      { name: 'q', in: 'query', required: true, schema: { type: 'string' } }, { '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' },
      { name: 'province', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string' } }
    ], responses: { '200': { description: 'Search results' } } } },
    '/api/v1/tenders/new': { get: { tags: ['Tenders'], summary: 'Recently published tenders', parameters: [
      { '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' }, { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } }
    ], responses: { '200': { description: 'Recent tenders' } } } },
    '/api/v1/tenders/closing-soon': { get: { tags: ['Tenders'], summary: 'Tenders closing soon', parameters: [
      { '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' }, { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } }
    ], responses: { '200': { description: 'Closing tenders' } } } },
    '/api/v1/tenders/{id}': { get: { tags: ['Tenders'], summary: 'Get a tender by internal id or OCID', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Tender', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Tender' } } } }, '404': { description: 'Not found' } } } },
    '/api/v1/tenders/{id}/raw': { get: { tags: ['Tenders'], summary: 'Get stored raw tender JSON', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Raw JSON' }, '404': { description: 'Not found' } } } },
    '/api/v1/tenders/{id}/timeline': { get: { tags: ['Tenders'], summary: 'Get tender release timeline', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Timeline' }, '404': { description: 'Not found' } } } },
    '/api/v1/tenders/{id}/awards': { get: { tags: ['Awards'], summary: 'Get awards for a tender', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Awards' }, '404': { description: 'Tender not found' } } } },
    '/api/v1/tenders/{id}/documents': { get: { tags: ['Tenders'], summary: 'Get documents for a tender', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Documents' }, '404': { description: 'Tender not found' } } } },
    '/api/v1/ocds/releases': { get: { tags: ['OCDS'], summary: 'List stored OCDS-style releases', parameters: [{ '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' }], responses: { '200': { description: 'Paginated releases' } } } },
    '/api/v1/ocds/releases/{releaseId}': { get: { tags: ['OCDS'], summary: 'Get one stored release', parameters: [{ name: 'releaseId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Release JSON' }, '404': { description: 'Not found' } } } },
    '/api/v1/ocds/records/{ocid}': { get: { tags: ['OCDS'], summary: 'Get all releases for an OCID', parameters: [{ name: 'ocid', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Record history' }, '404': { description: 'Not found' } } } },
    '/api/v1/buyers': { get: { tags: ['Buyers'], summary: 'List buyer organizations', parameters: [{ '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' }, { name: 'q', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Paginated buyers' } } } },
    '/api/v1/buyers/{id}': { get: { tags: ['Buyers'], summary: 'Get a buyer', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Buyer' }, '404': { description: 'Not found' } } } },
    '/api/v1/buyers/{id}/tenders': { get: { tags: ['Buyers'], summary: 'List tenders for a buyer', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' }], responses: { '200': { description: 'Buyer tenders' } } } },
    '/api/v1/suppliers': { get: { tags: ['Suppliers'], summary: 'List supplier organizations', parameters: [{ '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' }, { name: 'q', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Paginated suppliers' } } } },
    '/api/v1/suppliers/{id}': { get: { tags: ['Suppliers'], summary: 'Get a supplier', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Supplier' }, '404': { description: 'Not found' } } } },
    '/api/v1/awards': { get: { tags: ['Awards'], summary: 'List awards', parameters: [{ '$ref': '#/components/parameters/Page' }, { '$ref': '#/components/parameters/Limit' }], responses: { '200': { description: 'Paginated awards' } } } },
    '/api/v1/statistics/tenders': { get: { tags: ['Statistics'], summary: 'Tender database totals', responses: { '200': { description: 'Totals' } } } },
    '/api/v1/statistics/provinces': { get: { tags: ['Statistics'], summary: 'Tender counts by province', responses: { '200': { description: 'Province statistics' } } } },
    '/api/v1/statistics/categories': { get: { tags: ['Statistics'], summary: 'Tender counts by procurement category', responses: { '200': { description: 'Category statistics' } } } }
  }
};

app.get('/', async () => ({ name: 'TenderBase API', version: 'v1', status: 'ok', docs: '/docs', openapi: '/openapi.json' }));
app.get('/health', async (_request, reply) => { try { await db.$queryRaw`SELECT 1`; return { status: 'ok', service: 'tenderbase-api', database: 'ok' }; } catch { return reply.code(503).send({ status: 'error', service: 'tenderbase-api', database: 'error' }); } });
app.get('/openapi.json', async () => openapi);
app.get('/docs', async () => ({ message: 'TenderBase API documentation', openapi: '/openapi.json', version: apiInfo.version, resources: Object.keys(openapi.paths).filter(p => p.startsWith('/api/')) }));

function pagination(q: any) {
  const pageRaw = Number(q.page ?? 1); const limitRaw = Number(q.limit ?? q.pageSize ?? 25);
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 25;
  return { page, limit, skip: (page - 1) * limit };
}
function date(v?: string) { if (!v) return undefined; const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d; }
function dateFilter(from?: string, to?: string) { const gte = date(from); const lte = date(to); return gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined; }

app.get('/api/v1/tenders', async (request) => {
  const q = request.query as any; const { page, limit, skip } = pagination(q); const where: any = {};
  if (q.q) where.OR = [{ title: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }];
  if (q.status) where.status = q.status; if (q.province) where.province = q.province; if (q.category) where.mainProcurementCategory = q.category; if (q.buyerId) where.buyerId = q.buyerId;
  const published = dateFilter(q.publishedFrom, q.publishedTo); if (published) where.publishedDate = published; const closing = date(q.closingBefore); if (closing) where.closingDate = { lte: closing };
  const [items, total] = await Promise.all([db.tender.findMany({ where, orderBy: { publishedDate: 'desc' }, skip, take: limit, include: { buyer: true } }), db.tender.count({ where })]);
  return { page, limit, total, pages: Math.ceil(total / limit), items };
});
app.get('/api/v1/tenders/search', async (request) => {
  const q = request.query as any; const { page, limit, skip } = pagination(q); const where: any = q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] } : {};
  if (q.province) where.province = q.province; if (q.status) where.status = q.status; if (q.category) where.mainProcurementCategory = q.category;
  const [items, total] = await Promise.all([db.tender.findMany({ where, orderBy: { publishedDate: 'desc' }, skip, take: limit }), db.tender.count({ where })]);
  return { q: q.q ?? '', page, limit, total, pages: Math.ceil(total / limit), items };
});
app.get('/api/v1/tenders/new', async (request) => { const q = request.query as any; const { page, limit, skip } = pagination(q); const since = date(q.since) ?? new Date(Date.now() - 7 * 86400000); const where = { publishedDate: { gte: since } }; const [items, total] = await Promise.all([db.tender.findMany({ where, orderBy: { publishedDate: 'desc' }, skip, take: limit }), db.tender.count({ where })]); return { page, limit, total, pages: Math.ceil(total / limit), items }; });
app.get('/api/v1/tenders/closing-soon', async (request) => { const q = request.query as any; const { page, limit, skip } = pagination(q); const now = new Date(); const until = date(q.until) ?? new Date(now.getTime() + 7 * 86400000); const where = { closingDate: { gte: now, lte: until } }; const [items, total] = await Promise.all([db.tender.findMany({ where, orderBy: { closingDate: 'asc' }, skip, take: limit }), db.tender.count({ where })]); return { page, limit, total, pages: Math.ceil(total / limit), items }; });
app.get('/api/v1/tenders/:id', async (request, reply) => { const { id } = request.params as any; const item = await db.tender.findFirst({ where: { OR: [{ id }, { ocid: id }] }, include: { buyer: true, procuringEntity: true, lots: true, items: true, documents: true, briefings: true, contacts: true, awards: { include: { suppliers: { include: { organization: true } } } }, contracts: true } }); if (!item) return reply.code(404).send({ error: 'Tender not found' }); return item; });
app.get('/api/v1/tenders/:id/raw', async (request, reply) => { const { id } = request.params as any; const tender = await db.tender.findFirst({ where: { OR: [{ id }, { ocid: id }] } }); if (!tender) return reply.code(404).send({ error: 'Tender not found' }); return tender.rawJson; });
app.get('/api/v1/tenders/:id/timeline', async (request, reply) => { const { id } = request.params as any; const tender = await db.tender.findFirst({ where: { OR: [{ id }, { ocid: id }] } }); if (!tender) return reply.code(404).send({ error: 'Tender not found' }); return db.release.findMany({ where: { ocid: tender.ocid }, orderBy: { date: 'asc' }, select: { releaseId: true, date: true, tags: true, description: true, rawJson: true } }); });

app.get('/api/v1/ocds/releases', async (request) => { const q = request.query as any; const { page, limit, skip } = pagination(q); const [items, total] = await Promise.all([db.release.findMany({ orderBy: { date: 'desc' }, skip, take: limit }), db.release.count()]); return { page, limit, total, pages: Math.ceil(total / limit), items }; });
app.get('/api/v1/ocds/releases/:releaseId', async (request, reply) => { const { releaseId } = request.params as any; const r = await db.release.findUnique({ where: { releaseId } }); if (!r) return reply.code(404).send({ error: 'Release not found' }); return r.rawJson; });
app.get('/api/v1/ocds/records/:ocid', async (request, reply) => { const { ocid } = request.params as any; const releases = await db.release.findMany({ where: { ocid }, orderBy: { date: 'asc' } }); if (!releases.length) return reply.code(404).send({ error: 'Record not found' }); return { ocid, releases: releases.map(r => r.rawJson) }; });

app.get('/api/v1/buyers', async (request) => { const q = request.query as any; const { page, limit, skip } = pagination(q); const where: any = { roles: { some: { role: 'buyer' } } }; if (q.q) where.name = { contains: q.q, mode: 'insensitive' }; const [items, total] = await Promise.all([db.organization.findMany({ where, orderBy: { name: 'asc' }, skip, take: limit }), db.organization.count({ where })]); return { page, limit, total, pages: Math.ceil(total / limit), items }; });
app.get('/api/v1/buyers/:id', async (request, reply) => { const { id } = request.params as any; const x = await db.organization.findUnique({ where: { id }, include: { roles: true, buyerTenders: { take: 20, orderBy: { publishedDate: 'desc' } } } }); if (!x || !x.roles.some(r => r.role === 'buyer')) return reply.code(404).send({ error: 'Buyer not found' }); return x; });
app.get('/api/v1/buyers/:id/tenders', async (request, reply) => { const { id } = request.params as any; const { page, limit, skip } = pagination(request.query); const where = { buyerId: id }; const [items, total] = await Promise.all([db.tender.findMany({ where, orderBy: { publishedDate: 'desc' }, skip, take: limit }), db.tender.count({ where })]); return { page, limit, total, pages: Math.ceil(total / limit), items }; });

app.get('/api/v1/suppliers', async (request) => { const q = request.query as any; const { page, limit, skip } = pagination(q); const where: any = { roles: { some: { role: 'supplier' } } }; if (q.q) where.name = { contains: q.q, mode: 'insensitive' }; const [items, total] = await Promise.all([db.organization.findMany({ where, orderBy: { name: 'asc' }, skip, take: limit }), db.organization.count({ where })]); return { page, limit, total, pages: Math.ceil(total / limit), items }; });
app.get('/api/v1/suppliers/:id', async (request, reply) => { const { id } = request.params as any; const x = await db.organization.findUnique({ where: { id }, include: { roles: true, suppliers: { include: { award: true } } } }); if (!x || !x.roles.some(r => r.role === 'supplier')) return reply.code(404).send({ error: 'Supplier not found' }); return x; });

app.get('/api/v1/awards', async (request) => { const { page, limit, skip } = pagination(request.query); const [items, total] = await Promise.all([db.award.findMany({ orderBy: { date: 'desc' }, skip, take: limit, include: { suppliers: { include: { organization: true } } } }), db.award.count()]); return { page, limit, total, pages: Math.ceil(total / limit), items }; });
app.get('/api/v1/tenders/:id/awards', async (request, reply) => { const { id } = request.params as any; const tender = await db.tender.findFirst({ where: { OR: [{ id }, { ocid: id }] } }); if (!tender) return reply.code(404).send({ error: 'Tender not found' }); return db.award.findMany({ where: { tenderId: tender.id }, include: { suppliers: { include: { organization: true } } } }); });
app.get('/api/v1/tenders/:id/documents', async (request, reply) => { const { id } = request.params as any; const tender = await db.tender.findFirst({ where: { OR: [{ id }, { ocid: id }] } }); if (!tender) return reply.code(404).send({ error: 'Tender not found' }); return db.document.findMany({ where: { tenderId: tender.id } }); });

app.get('/api/v1/statistics/tenders', async () => ({ tenders: await db.tender.count(), releases: await db.release.count(), sourceRecords: await db.sourceRecord.count(), organizations: await db.organization.count(), awards: await db.award.count(), contracts: await db.contract.count() }));
app.get('/api/v1/statistics/provinces', async () => db.tender.groupBy({ by: ['province'], _count: { _all: true }, orderBy: { _count: { province: 'desc' } } }));
app.get('/api/v1/statistics/categories', async () => db.tender.groupBy({ by: ['mainProcurementCategory'], _count: { _all: true }, orderBy: { _count: { mainProcurementCategory: 'desc' } } }));

const port = Number(process.env.PORT ?? 10000); const host = process.env.HOST ?? '0.0.0.0';
app.listen({ port, host }).catch(async error => { app.log.error(error); await db.$disconnect(); process.exit(1); });
