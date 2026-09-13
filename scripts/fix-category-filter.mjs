import fs from 'node:fs';

const file = 'src/server.ts';
let source = fs.readFileSync(file, 'utf8');

// The public API exposes Tender.category. mainProcurementCategory is null in
// the current normalized dataset, so category filters must use category.
source = source.replaceAll('if (q.category) where.mainProcurementCategory = q.category;', 'if (q.category) where.category = { contains: q.category, mode: \'insensitive\' };');
source = source.replaceAll('if (q.category) where.mainProcurementCategory = q.category;', 'if (q.category) where.category = { contains: q.category, mode: \'insensitive\' };');

fs.writeFileSync(file, source);
console.log('TenderBase category filter fixed to use Tender.category');
