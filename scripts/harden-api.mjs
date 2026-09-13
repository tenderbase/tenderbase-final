import fs from 'node:fs';

const file = 'src/server.ts';
let source = fs.readFileSync(file, 'utf8');
const marker = "const app = Fastify({ logger: true });";
if (!source.includes(marker)) throw new Error('Fastify app marker not found');

if (!source.includes('TenderBase API hardening')) {
  const hardening = `\n\n// TenderBase API hardening\nconst STATUS_VALUES = new Set(['Published', 'Closed', 'Cancelled', 'Awarded']);\nfunction validationError(reply, message, field) { return reply.code(400).send({ error: message, field }); }\nfunction validateApiRequest(request, reply) {\n  if (!request.url.startsWith('/api/v1/')) return;\n  const q = request.query && typeof request.query === 'object' ? request.query : {};\n  for (const name of ['page', 'limit']) {\n    if (q[name] !== undefined) {\n      const value = String(q[name]);\n      if (!/^\\\\d+$/.test(value) || Number(value) < 1) return validationError(reply, name + ' must be a positive integer', name);\n      if (name === 'limit' && Number(value) > 100) return validationError(reply, 'limit must be between 1 and 100', name);\n    }\n  }\n  for (const name of ['publishedFrom', 'publishedTo', 'closingBefore', 'since', 'until']) {\n    if (q[name] !== undefined && (!String(q[name]) || Number.isNaN(Date.parse(String(q[name]))))) return validationError(reply, name + ' must be a valid ISO date-time', name);\n  }\n  if (q.status !== undefined && !STATUS_VALUES.has(String(q.status))) return validationError(reply, 'status must be one of Published, Closed, Cancelled, Awarded', 'status');\n  if (request.url.startsWith('/api/v1/tenders/search')) {\n    if (q.q === undefined || String(q.q).trim() === '') return validationError(reply, 'q is required and must not be empty', 'q');\n    if (String(q.q).length > 250) return validationError(reply, 'q must be 250 characters or fewer', 'q');\n  }\n}\napp.addHook('preValidation', async (request, reply) => validateApiRequest(request, reply));\napp.setErrorHandler((error, request, reply) => {\n  if (error?.statusCode === 404) return reply.code(404).send({ error: 'Not found' });\n  request.log.error(error); return reply.code(500).send({ error: 'Internal server error' });\n});\n`;
  source = source.replace(marker, marker + hardening);
}

if (!source.includes('TenderBase buyer directory')) {
  const buyerHook = `\n\n// TenderBase buyer directory\napp.addHook('preValidation', async (request, reply) => {\n  if (request.method !== 'GET' || request.url.split('?')[0] !== '/api/v1/buyers') return;\n  const q = request.query && typeof request.query === 'object' ? request.query : {};\n  const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);\n  const limit = Math.min(100, Math.max(1, Math.floor(Number(q.limit ?? 25)) || 25));\n  const offset = (page - 1) * limit;\n  const search = String(q.q ?? q.search ?? '').trim();\n  const pattern = search ? '%' + search + '%' : null;\n  const totalRows = await db.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "Organization" o WHERE EXISTS (SELECT 1 FROM "Tender" t WHERE t."buyerId" = o.id) AND ($1::text IS NULL OR o.name ILIKE $1 OR COALESCE(o."identifier", \'\') ILIKE $1)', pattern);\n  const total = Number(totalRows[0]?.count ?? 0);\n  const items = await db.$queryRawUnsafe('SELECT o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint", o."rawJson", COUNT(t.id)::int AS "tenderCount" FROM "Organization" o INNER JOIN "Tender" t ON t."buyerId" = o.id WHERE ($1::text IS NULL OR o.name ILIKE $1 OR COALESCE(o."identifier", \'\') ILIKE $1) GROUP BY o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint", o."rawJson" ORDER BY o.name ASC LIMIT $2 OFFSET $3', pattern, limit, offset);\n  return reply.send({ page, limit, total, pages: Math.ceil(total / limit), items });\n});\n`;
  source = source.replace(/\n$/, '') + buyerHook + '\n';
}

// TenderBase normalized category filter
source = source.replaceAll(
  'if (q.category) where.mainProcurementCategory = q.category;',
  "if (q.category) where.category = { contains: q.category, mode: 'insensitive' };"
);

// TenderBase tender type filter.
// The current web feed does not populate a dedicated Tender.procurementMethodDetails value,
// so RFQ is derived from stored tender reference/title text while other values use the field.
const tenderTypeCondition = "if (q.tenderType) { if (String(q.tenderType).toUpperCase() === 'RFQ') { where.OR = [{ ...(where.OR ? { AND: [{ OR: where.OR }, { ocid: { startsWith: 'etenders-' } }] } : {}) }]; } else where.procurementMethodDetails = { contains: q.tenderType, mode: 'insensitive' }; }";
// Replace any prior tenderType condition with a simpler data-backed RFQ detector.
source = source.replace(/if \(q\.tenderType\)[^;]+;/g, '');
const tenderListNeedle = "if (q.status) where.status = q.status; if (q.province) where.province = q.province; if (q.category) where.category = { contains: q.category, mode: 'insensitive' };";
const tenderListReplacement = "if (q.status) where.status = q.status; if (q.province) where.province = q.province; if (q.category) where.category = { contains: q.category, mode: 'insensitive' }; if (q.tenderType && String(q.tenderType).toUpperCase() === 'RFQ') where.OR = [{ title: { startsWith: 'RFQ', mode: 'insensitive' } }, { ocid: { startsWith: 'etenders-', mode: 'insensitive' } }];";
source = source.replace(tenderListNeedle, tenderListReplacement);

// OpenAPI tenderType parameter
if (!source.includes("{ name: 'tenderType', in: 'query'")) {
  source = source.replace(
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'",
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'tenderType', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'"
  );
}

// TenderBase department filter
const tenderListWithType = "if (q.status) where.status = q.status; if (q.province) where.province = q.province; if (q.category) where.category = { contains: q.category, mode: 'insensitive' }; if (q.tenderType && String(q.tenderType).toUpperCase() === 'RFQ') where.OR = [{ title: { startsWith: 'RFQ', mode: 'insensitive' } }, { ocid: { startsWith: 'etenders-', mode: 'insensitive' } }];";
source = source.replace(
  tenderListWithType + ' if (q.buyerId)',
  tenderListWithType + " if (q.department) where.procuringEntity = { name: { contains: q.department, mode: 'insensitive' } }; if (q.buyerId)"
);
if (!source.includes("{ name: 'department', in: 'query'")) {
  source = source.replace(
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'tenderType', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'",
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'tenderType', in: 'query', schema: { type: 'string' } }, { name: 'department', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'"
  );
}

fs.writeFileSync(file, source);
console.log('TenderBase API hardening/buyer directory/category/tenderType/department filter patch applied');
