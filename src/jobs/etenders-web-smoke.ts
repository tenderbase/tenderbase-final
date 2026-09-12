import { EtendersWebClient } from '../collectors/etenders/web-client.js';

const client = new EtendersWebClient();
const length = Math.min(Math.max(Number(process.env.ETENDERS_SMOKE_LENGTH ?? 10), 1), 100);
const page = await client.getOpportunities({ length, status: 1 });

console.log(JSON.stringify({
  status: 'ok',
  endpoint: '/Home/PaginatedTenderOpportunities',
  recordsTotal: page.recordsTotal,
  recordsFiltered: page.recordsFiltered,
  rows: page.rows.length,
  sample: page.releases.slice(0, 3).map((release) => ({
    ocid: release.ocid,
    title: release.tender?.title,
    published: release.date,
    closing: release.tender?.tenderPeriod?.endDate,
    province: release.tender?.province,
    buyer: release.buyer,
  })),
}));
