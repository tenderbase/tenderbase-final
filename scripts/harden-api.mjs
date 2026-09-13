import fs from 'node:fs';

const file = 'src/server.ts';
const source = fs.readFileSync(file, 'utf8');

const marker = "const app = Fastify({ logger: true });";
if (!source.includes(marker)) throw new Error('Fastify app marker not found');
if (source.includes('TenderBase API hardening')) process.exit(0);

const hardening = `

// TenderBase API hardening
const STATUS_VALUES = new Set(['Published', 'Closed', 'Cancelled', 'Awarded']);

function validationError(reply: any, message: string, field: string) {
  return reply.code(400).send({ error: message, field });
}

function validateApiRequest(request: any, reply: any) {
  if (!request.url.startsWith('/api/v1/')) return;
  const q = request.query && typeof request.query === 'object' ? request.query : {};

  for (const name of ['page', 'limit']) {
    if (q[name] !== undefined) {
      const value = String(q[name]);
      if (!/^\\d+$/.test(value) || Number(value) < 1) return validationError(reply, name + ' must be a positive integer', name);
      if (name === 'limit' && Number(value) > 100) return validationError(reply, 'limit must be between 1 and 100', name);
    }
  }

  for (const name of ['publishedFrom', 'publishedTo', 'closingBefore', 'since', 'until']) {
    if (q[name] !== undefined) {
      const value = String(q[name]);
      if (!value || Number.isNaN(Date.parse(value))) return validationError(reply, name + ' must be a valid ISO date-time', name);
    }
  }

  if (q.status !== undefined && !STATUS_VALUES.has(String(q.status))) {
    return validationError(reply, 'status must be one of Published, Closed, Cancelled, Awarded', 'status');
  }

  if (request.url.startsWith('/api/v1/tenders/search')) {
    if (q.q === undefined || String(q.q).trim() === '') return validationError(reply, 'q is required and must not be empty', 'q');
    if (String(q.q).length > 250) return validationError(reply, 'q must be 250 characters or fewer', 'q');
  }
}

app.addHook('preValidation', async (request: any, reply: any) => {
  if (request.method === 'GET' && request.url.split('?')[0] === '/api/v1/buyers') {
    const q = request.query && typeof request.query === 'object' ? request.query : {};
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25)));
    const offset = (page - 1) * limit;
    const search = String(q.q ?? q.search ?? '').trim();
    const pattern = search ? `%${search}%` : null;

    const totalRows: any[] = await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
       FROM "Organization" o
       WHERE EXISTS (SELECT 1 FROM "Tender" t WHERE t."buyerId" = o.id)
       AND ($1::text IS NULL OR o.name ILIKE $1 OR COALESCE(o."identifier", '') ILIKE $1)`,
      pattern
    );
    const total = Number(totalRows[0]?.count ?? 0);

    const items = await db.$queryRawUnsafe(
      `SELECT o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint", o."rawJson",
              COUNT(t.id)::int AS "tenderCount"
       FROM "Organization" o
       INNER JOIN "Tender" t ON t."buyerId" = o.id
       WHERE ($1::text IS NULL OR o.name ILIKE $1 OR COALESCE(o."identifier", '') ILIKE $1)
       GROUP BY o.id, o."ocdsId", o.name, o.identifier, o.address, o."contactPoint", o."rawJson"
       ORDER BY o.name ASC
       LIMIT $2 OFFSET $3`,
      pattern, limit, offset
    );

    return reply.send({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items
    });
  }

  return validateApiRequest(request, reply);
});
app.setErrorHandler((error: any, request: any, reply: any) => {
  if (error?.statusCode === 404) return reply.code(404).send({ error: 'Not found' });
  request.log.error(error);
  return reply.code(500).send({ error: 'Internal server error' });
});
`;

fs.writeFileSync(file, source.replace(marker, marker + hardening));
console.log('TenderBase API hardening and buyer directory injected into src/server.ts');
