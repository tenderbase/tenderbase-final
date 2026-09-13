import { createHash } from 'node:crypto';
import { db } from '../../db.js';
import type { Release, Party } from './types.js';

const SOURCE_KEY = 'etenders-web';
const SOURCE_NAME = 'South Africa eTenders official website';
const SOURCE_URL = process.env.ETENDERS_WEB_BASE_URL ?? 'https://www.etenders.gov.za';

const asDate = (v?: string) => v ? new Date(v) : undefined;
const json = (v: unknown) => (v ?? undefined) as any;
const amount = (v?: { amount?: number }) => v?.amount == null ? undefined : v.amount;
const currency = (v?: { currency?: string }) => v?.currency;

function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function identifier(p: Party) {
  const x = p.identifier as any;
  return typeof x === 'object' && x ? String(x.id ?? x.legalName ?? '') || undefined : undefined;
}

export async function ensureSource() {
  return db.source.upsert({ where: { key: SOURCE_KEY }, create: { key: SOURCE_KEY, name: SOURCE_NAME, baseUrl: SOURCE_URL }, update: { name: SOURCE_NAME, baseUrl: SOURCE_URL } });
}

async function upsertOrganization(p: Party, role?: string) {
  if (!p.id && !p.name) return undefined;
  const ocdsId = p.id;
  const existing = ocdsId ? await db.organization.findUnique({ where: { ocdsId } }) : null;
  const org = existing
    ? await db.organization.update({ where: { id: existing.id }, data: { name: p.name ?? existing.name, identifier: identifier(p), address: json(p.address), contactPoint: json(p.contactPoint), rawJson: json(p) } })
    : await db.organization.create({ data: { ocdsId, name: p.name ?? 'Unknown organization', identifier: identifier(p), address: json(p.address), contactPoint: json(p.contactPoint), rawJson: json(p) } });
  if (role) await db.organizationRole.upsert({ where: { organizationId_role: { organizationId: org.id, role } }, create: { organizationId: org.id, role }, update: {} });
  return org;
}

export async function persistRelease(release: Release) {
  const source = await ensureSource();
  const contentHash = hash(release);
  const sourceRecord = await db.sourceRecord.upsert({
    where: { sourceId_releaseId: { sourceId: source.id, releaseId: release.id } },
    create: { sourceId: source.id, releaseId: release.id, ocid: release.ocid, releaseDate: asDate(release.date), contentHash, rawJson: json(release) },
    update: { ocid: release.ocid, releaseDate: asDate(release.date), contentHash, rawJson: json(release), ingestedAt: new Date() }
  });

  await db.release.upsert({
    where: { releaseId: release.id },
    create: { sourceRecordId: sourceRecord.id, ocid: release.ocid, releaseId: release.id, date: asDate(release.date), tags: release.tag ?? [], initiationType: release.initiationType, language: release.language, description: release.description, tenderId: release.tender?.id, rawJson: json(release) },
    update: { sourceRecordId: sourceRecord.id, ocid: release.ocid, date: asDate(release.date), tags: release.tag ?? [], initiationType: release.initiationType, language: release.language, description: release.description, tenderId: release.tender?.id, rawJson: json(release) }
  });

  if (release.relatedProcesses?.length) {
    const rel = await db.release.findUniqueOrThrow({ where: { releaseId: release.id } });
    await db.relatedProcess.deleteMany({ where: { releaseId: rel.id } });
    for (const rp of release.relatedProcesses) if (rp.identifier) await db.relatedProcess.create({ data: { releaseId: rel.id, relationship: (rp.relationship ?? []).join(','), identifier: rp.identifier, scheme: rp.scheme, uri: rp.uri } });
  }

  const t = release.tender;
  if (!t) return { sourceRecordId: sourceRecord.id, releaseId: release.id, normalized: false };
  const buyer = release.parties?.find(p => p.id === (release.buyer as any)?.id) ?? (release.buyer as Party | undefined);
  const procuring = t.procuringEntity as Party | undefined;
  const buyerOrg = buyer ? await upsertOrganization(buyer, 'buyer') : undefined;
  const procuringOrg = procuring ? await upsertOrganization(procuring, 'procuringEntity') : undefined;
  const tender = await db.tender.upsert({
    where: { ocid: release.ocid },
    create: { ocid: release.ocid, latestReleaseId: release.id, title: t.title, description: t.description, status: t.status, category: t.category, province: t.province, procurementMethod: t.procurementMethod, procurementMethodDetails: t.procurementMethodDetails, mainProcurementCategory: t.mainProcurementCategory, publishedDate: asDate(release.date), closingDate: asDate(t.tenderPeriod?.endDate), enquiryStart: asDate(t.enquiryPeriod?.startDate), enquiryEnd: asDate(t.enquiryPeriod?.endDate), awardStart: asDate(t.awardPeriod?.startDate), awardEnd: asDate(t.awardPeriod?.endDate), valueAmount: amount(t.value), valueCurrency: currency(t.value), buyerId: buyerOrg?.id, procuringEntityId: procuringOrg?.id, rawJson: json(t) },
    update: { latestReleaseId: release.id, title: t.title, description: t.description, status: t.status, category: t.category, province: t.province, procurementMethod: t.procurementMethod, procurementMethodDetails: t.procurementMethodDetails, mainProcurementCategory: t.mainProcurementCategory, publishedDate: asDate(release.date), closingDate: asDate(t.tenderPeriod?.endDate), enquiryStart: asDate(t.enquiryPeriod?.startDate), enquiryEnd: asDate(t.enquiryPeriod?.endDate), awardStart: asDate(t.awardPeriod?.startDate), awardEnd: asDate(t.awardPeriod?.endDate), valueAmount: amount(t.value), valueCurrency: currency(t.value), buyerId: buyerOrg?.id, procuringEntityId: procuringOrg?.id, rawJson: json(t) }
  });

  await db.tenderItem.deleteMany({ where: { tenderId: tender.id } });
  for (const item of t.items ?? []) await db.tenderItem.create({ data: { tenderId: tender.id, itemId: item.id ?? hash(item).slice(0, 24), description: item.description, quantity: item.quantity, unit: json(item.unit), classification: json(item.classification), deliveryAddress: json(item.deliveryAddress), deliveryPeriod: json(item.deliveryPeriod) } });
  await db.document.deleteMany({ where: { tenderId: tender.id } });
  for (const d of t.documents ?? []) {
    await db.document.create({ data: {
      tenderId: tender.id,
      documentId: d.id ?? d.supportDocumentId ?? d.blobName ?? hash(d).slice(0, 24),
      documentType: d.documentType,
      title: d.title,
      description: d.description,
      format: d.format,
      url: d.url,
      datePublished: asDate(d.datePublished),
      dateModified: asDate(d.dateModified),
      supportDocumentId: d.supportDocumentId,
      blobName: d.blobName,
      downloadedFileName: d.downloadedFileName,
      downloadStatus: d.blobName ? 'discovered' : 'missing_blob_name',
    } });
  }
  await db.lot.deleteMany({ where: { tenderId: tender.id } });
  for (const lot of t.lots ?? []) if (lot.id) await db.lot.create({ data: { tenderId: tender.id, lotId: lot.id, title: lot.title, description: lot.description, valueAmount: amount(lot.value), currency: currency(lot.value) } });
  await db.contact.deleteMany({ where: { tenderId: tender.id } });
  if (t.contactPerson) await db.contact.create({ data: { tenderId: tender.id, name: t.contactPerson.name, email: t.contactPerson.email, telephone: t.contactPerson.telephone, faxNumber: t.contactPerson.faxNumber } });
  await db.briefing.deleteMany({ where: { tenderId: tender.id } });
  if (t.briefingSession) await db.briefing.create({ data: { tenderId: tender.id, briefingId: `${release.id}:briefing`, date: asDate(t.briefingSession.date), venue: t.briefingSession.venue, address: json(t.briefingSession.address) } });

  for (const award of release.awards ?? []) {
    if (!award.id) continue;
    const a = await db.award.upsert({ where: { tenderId_awardId: { tenderId: tender.id, awardId: award.id } }, create: { tenderId: tender.id, awardId: award.id, status: award.status, title: award.title, description: award.description, date: asDate(award.date), valueAmount: amount(award.value), valueCurrency: currency(award.value), rawJson: json(award) }, update: { status: award.status, title: award.title, description: award.description, date: asDate(award.date), valueAmount: amount(award.value), valueCurrency: currency(award.value), rawJson: json(award) } });
    await db.awardSupplier.deleteMany({ where: { awardId: a.id } });
    for (const supplier of award.suppliers ?? []) { const org = await upsertOrganization(supplier, 'supplier'); if (org) await db.awardSupplier.create({ data: { awardId: a.id, organizationId: org.id } }); }
  }
  for (const contract of release.contracts ?? []) if (contract.id) {
    const award = contract.awardID ? await db.award.findFirst({ where: { tenderId: tender.id, awardId: contract.awardID } }) : null;
    await db.contract.upsert({ where: { tenderId_contractId: { tenderId: tender.id, contractId: contract.id } }, create: { tenderId: tender.id, awardId: award?.id, contractId: contract.id, title: contract.title, period: json(contract.period), valueAmount: amount(contract.value), valueCurrency: currency(contract.value), rawJson: json(contract) }, update: { awardId: award?.id, title: contract.title, period: json(contract.period), valueAmount: amount(contract.value), valueCurrency: currency(contract.value), rawJson: json(contract) } });
  }
  return { sourceRecordId: sourceRecord.id, releaseId: release.id, normalized: true, tenderId: tender.id, documents: t.documents?.length ?? 0, downloadableDocuments: t.documents?.filter(d => d.blobName).length ?? 0 };
}
