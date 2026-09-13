import fs from 'node:fs';

const file = 'src/server.ts';
const source = fs.readFileSync(file, 'utf8');

const marker = "const app = Fastify({ logger: true });";
if (!source.includes(marker)) throw new Error('Fastify app marker not found');
if (source.includes('TenderBase API hardening')) process.exit(0);

const hardening = `\n\n// TenderBase API hardening\nconst STATUS_VALUES = new Set(['Published', 'Closed', 'Cancelled', 'Awarded']);\n\nfunction validationError(reply: any, message: string, field: string) {\n  return reply.code(400).send({ error: message, field });\n}\n\nfunction validateApiRequest(request: any, reply: any) {\n  if (!request.url.startsWith('/api/v1/')) return;\n  const q = request.query && typeof request.query === 'object' ? request.query : {};\n\n  for (const name of ['page', 'limit']) {\n    if (q[name] !== undefined) {\n      const value = String(q[name]);\n      if (!/^\\d+$/.test(value) || Number(value) < 1) return validationError(reply, name + ' must be a positive integer', name);\n      if (name === 'limit' && Number(value) > 100) return validationError(reply, 'limit must be between 1 and 100', name);\n    }\n  }\n\n  for (const name of ['publishedFrom', 'publishedTo', 'closingBefore', 'since', 'until']) {\n    if (q[name] !== undefined) {\n      const value = String(q[name]);\n      if (!value || Number.isNaN(Date.parse(value))) return validationError(reply, name + ' must be a valid ISO date-time', name);\n    }\n  }\n\n  if (q.status !== undefined && !STATUS_VALUES.has(String(q.status))) {\n    return validationError(reply, 'status must be one of Published, Closed, Cancelled, Awarded', 'status');\n  }\n\n  if (request.url.startsWith('/api/v1/tenders/search')) {\n    if (q.q === undefined || String(q.q).trim() === '') return validationError(reply, 'q is required and must not be empty', 'q');\n    if (String(q.q).length > 250) return validationError(reply, 'q must be 250 characters or fewer', 'q');\n  }\n}\n\napp.addHook('preValidation', async (request: any, reply: any) => validateApiRequest(request, reply));\napp.setErrorHandler((error: any, request: any, reply: any) => {\n  if (error?.statusCode === 404) return reply.code(404).send({ error: 'Not found' });\n  request.log.error(error);\n  return reply.code(500).send({ error: 'Internal server error' });\n});\n`;

fs.writeFileSync(file, source.replace(marker, marker + hardening));
console.log('TenderBase API hardening injected into src/server.ts');
