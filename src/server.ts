import Fastify from 'fastify';
import { db } from './db.js';

const app = Fastify({ logger: true });

app.get('/health', async () => {
  await db.$queryRaw`SELECT 1`;
  return { status: 'ok', service: 'tenderbase-api' };
});

app.get('/api/v1/tenders', async (request) => {
  const query = request.query as Record<string, string | undefined>;
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));
  const skip = (page - 1) * pageSize;
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.procurementMethod ? { procurementMethod: query.procurementMethod } : {}),
    ...(query.category ? { mainProcurementCategory: query.category } : {})
  };

  const [items, total] = await Promise.all([
    db.tender.findMany({ where, orderBy: { publishedDate: 'desc' }, skip, take: pageSize }),
    db.tender.count({ where })
  ]);

  return { page, pageSize, total, items };
});

app.get('/api/v1/tenders/:ocid', async (request, reply) => {
  const { ocid } = request.params as { ocid: string };
  const tender = await db.tender.findUnique({
    where: { ocid },
    include: { items: true, documents: true, awards: true, contracts: true }
  });
  if (!tender) return reply.code(404).send({ error: 'Tender not found' });
  return tender;
});

app.get('/api/v1/ocds/releases/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const release = await db.ocdsRelease.findUnique({ where: { id } });
  if (!release) return reply.code(404).send({ error: 'Release not found' });
  return release;
});

const port = Number(process.env.PORT ?? 10000);
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host }).catch(async (error) => {
  app.log.error(error);
  await db.$disconnect();
  process.exit(1);
});
