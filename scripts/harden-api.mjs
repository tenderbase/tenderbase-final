import fs from 'node:fs';

const file = 'src/server.ts';
let source = fs.readFileSync(file, 'utf8');
const marker = "const app = Fastify({ logger: true });";
if (!source.includes(marker)) throw new Error('Fastify app marker not found');

if (!source.includes('TenderBase API hardening')) {
  const hardening = [
    '',
    '// TenderBase API hardening',
    "const STATUS_VALUES = new Set(['Published', 'Closed', 'Cancelled', 'Awarded']);",
    'function validationError(reply, message, field) { return reply.code(400).send({ error: message, field }); }',
    'function validateApiRequest(request, reply) {',
    "  if (!request.url.startsWith('/api/v1/')) return;",
    "  const q = request.query && typeof request.query === 'object' ? request.query : {};",
    "  for (const name of ['page', 'limit']) {",
    '    if (q[name] !== undefined) {',
    '      const value = String(q[name]);',
    "      if (!/^\\d+$/.test(value) || Number(value) < 1) return validationError(reply, name + ' must be a positive integer', name);",
    "      if (name === 'limit' && Number(value) > 100) return validationError(reply, 'limit must be between 1 and 100', name);",
    '    }',
    '  }',
    "  for (const name of ['publishedFrom', 'publishedTo', 'closingBefore', 'since', 'until']) {",
    "    if (q[name] !== undefined && (!String(q[name]) || Number.isNaN(Date.parse(String(q[name]))))) return validationError(reply, name + ' must be a valid ISO date-time', name);",
    '  }',
    "  if (q.status !== undefined && !STATUS_VALUES.has(String(q.status))) return validationError(reply, 'status must be one of Published, Closed, Cancelled, Awarded', 'status');",
    "  if (request.url.startsWith('/api/v1/tenders/search')) {",
    "    if (q.q === undefined || String(q.q).trim() === '') return validationError(reply, 'q is required and must not be empty', 'q');",
    "    if (String(q.q).length > 250) return validationError(reply, 'q must be 250 characters or fewer', 'q');",
    '  }',
    '}',
    "app.addHook('preValidation', async (request, reply) => validateApiRequest(request, reply));",
    "app.setErrorHandler((error, request, reply) => {",
    "  if (error?.statusCode === 404) return reply.code(404).send({ error: 'Not found' });",
    "  request.log.error(error); return reply.code(500).send({ error: 'Internal server error' });",
    '});',
    ''
  ].join('\n');
  source = source.replace(marker, marker + hardening);
}

if (!source.includes('TenderBase buyer directory')) {
  const buyerHook = [
    '',
    '// TenderBase buyer directory',
    "app.addHook('preValidation', async (request, reply) => {",
    "  if (request.method !== 'GET' || request.url.split('?')[0] !== '/api/v1/buyers') return;",
    "  const q = request.query && typeof request.query === 'object' ? request.query : {};",
    '  const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);',
    '  const limit = Math.min(100, Math.max(1, Math.floor(Number(q.limit ?? 25)) || 25));',
    '  const offset = (page - 1) * limit;',
    "  const search = String(q.q ?? q.search ?? '').trim();",
    "  const pattern = search ? '%' + search + '%' : null;",
    '  const totalRows = await db.$queryRawUnsafe(\'SELECT COUNT(*)::int AS count FROM "Organization" o WHERE EXISTS (SELECT 1 FROM "Tender" t WHERE t."buyerId" = o.id) AND ($1::text IS NULL OR o.name ILIKE $1 OR COALESCE(o."identifier", \'\') ILIKE $1)\', pattern);',
    '  const total = Number(totalRows[0]?.count ?? 0);',
    '  const items = await db.$queryRawUnsafe(\'SELECT o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint", o."rawJson", COUNT(t.id)::int AS "tenderCount" FROM "Organization" o INNER JOIN "Tender" t ON t."buyerId" = o.id WHERE ($1::text IS NULL OR o.name ILIKE $1 OR COALESCE(o."identifier", \'\') ILIKE $1) GROUP BY o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint", o."rawJson" ORDER BY o.name ASC LIMIT $2 OFFSET $3\', pattern, limit, offset);',
    '  return reply.send({ page, limit, total, pages: Math.ceil(total / limit), items });',
    '});',
    ''
  ].join('\n');
  source = source.replace(/\n$/, '') + buyerHook + '\n';
}

// TenderBase normalized category filter
source = source.replaceAll(
  'if (q.category) where.mainProcurementCategory = q.category;',
  "if (q.category) where.category = { contains: q.category, mode: 'insensitive' };"
);

// Tender type filter. RFQ is represented in the current stored tender title/description data.
const tenderTypeRoute = "if (q.tenderType && String(q.tenderType).toUpperCase() === 'RFQ') where.OR = [{ title: { contains: 'RFQ', mode: 'insensitive' } }, { description: { contains: 'RFQ', mode: 'insensitive' } }];";
const tenderListNeedle = "if (q.status) where.status = q.status; if (q.province) where.province = q.province; if (q.category) where.category = { contains: q.category, mode: 'insensitive' };";
const tenderListReplacement = tenderListNeedle + ' ' + tenderTypeRoute;
source = source.replace(tenderListNeedle, tenderListReplacement);
source = source.replace(
  tenderListReplacement + ' if (q.buyerId)',
  tenderListReplacement + " if (q.department) where.procuringEntity = { name: { contains: q.department, mode: 'insensitive' } }; if (q.buyerId)"
);

// OpenAPI tenderType and department parameters
if (!source.includes("{ name: 'tenderType', in: 'query'")) {
  source = source.replace(
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'",
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'tenderType', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'"
  );
}
if (!source.includes("{ name: 'department', in: 'query'")) {
  source = source.replace(
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'tenderType', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'",
    "{ name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'tenderType', in: 'query', schema: { type: 'string' } }, { name: 'department', in: 'query', schema: { type: 'string' } }, { name: 'buyerId'"
  );
}

fs.writeFileSync(file, source);
console.log('TenderBase API hardening/buyer directory/category/tenderType/department filter patch applied');
