import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { fetchReleases, type OcdsRelease } from './etenders.js';

const PAGE_SIZE = Number(process.env.ETENDERS_PAGE_SIZE ?? 100);
const MAX_PAGES = Number(process.env.ETENDERS_MAX_PAGES ?? 10000);

function date(value: unknown): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function decimal(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function json(value: unknown): any {
  return value === undefined ? undefined : value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function upsertOrganization(party: any, role?: string) {
  if (!party) return undefined;
  const ocdsId = party.id ? String(party.id) : undefined;
  const existing = ocdsId
    ? await db.organization.findUnique({ where: { ocdsId } })
    : undefined;

  const organization = existing
    ? await db.organization.update({
        where: { id: existing.id },
        data: {
          name: String(party.name ?? existing.name),
          identifier: party.identifier?.id ? String(party.identifier.id) : existing.identifier,
          address: json(party.address) ?? existing.address,
          contactPoint: json(party.contactPoint) ?? existing.contactPoint,
          rawJson: party
        }
      })
    : await db.organization.create({
        data: {
          ocdsId,
          name: String(party.name ?? 'Unknown'),
          identifier: party.identifier?.id ? String(party.identifier.id) : undefined,
          address: json(party.address),
          contactPoint: json(party.contactPoint),
          rawJson: party
        }
      });

  if (role) {
    await db.organizationRole.upsert({
      where: { organizationId_role: { organizationId: organization.id, role } },
      create: { organizationId: organization.id, role },
      update: {}
    });
  }
  return organization;
}

async function ingestRelease(release: OcdsRelease) {
  const releaseId = release.id ? String(release.id) : undefined;
  if (!releaseId) throw new Error('Release is missing id');
  const ocid = String(release.ocid ?? releaseId);
  const parties = Array.isArray(release.parties) ? release.parties : [];

  const source = await db.source.upsert({
    where: { key: 'etenders-ocds' },
    create: {
      key: 'etenders-ocds',
      name: 'National Treasury eTenders OCDS',
      baseUrl: 'https://ocds-api.etenders.gov.za'
    },
    update: {}
  });

  const sourceRecord = await db.sourceRecord.upsert({
    where: { sourceId_releaseId: { sourceId: source.id, releaseId } },
    create: {
      sourceId: source.id,
      releaseId,
      ocid,
      releaseDate: date(release.date),
      contentHash: hash(release),
      rawJson: release
    },
    update: {
      ocid,
      releaseDate: date(release.date),
      contentHash: hash(release),
      rawJson: release
    }
  });

  const buyerParty = release.buyer?.id
    ? parties.find((party: any) => String(party.id) === String(release.buyer.id))
    : release.buyer;
  const buyer = await upsertOrganization(buyerParty, 'buyer');

  const procuringParty = release.tender?.procuringEntity?.id
    ? parties.find((party: any) => String(party.id) === String(release.tender.procuringEntity.id))
    : release.tender?.procuringEntity;
  const procuringEntity = await upsertOrganization(procuringParty, 'procuringEntity');

  const storedRelease = await db.release.upsert({
    where: { releaseId },
    create: {
      sourceRecordId: sourceRecord.id,
      ocid,
      releaseId,
      date: date(release.date),
      tags: Array.isArray(release.tag) ? release.tag.map(String) : [],
      initiationType: release.initiationType ? String(release.initiationType) : undefined,
      language: release.language ? String(release.language) : undefined,
      description: release.description ? String(release.description) : undefined,
      rawJson: release
    },
    update: {
      sourceRecordId: sourceRecord.id,
      ocid,
      date: date(release.date),
      tags: Array.isArray(release.tag) ? release.tag.map(String) : [],
      initiationType: release.initiationType ? String(release.initiationType) : undefined,
      language: release.language ? String(release.language) : undefined,
      description: release.description ? String(release.description) : undefined,
      rawJson: release
    }
  });

  const tender = release.tender;
  if (!tender) return;

  const tenderRecord = await db.tender.upsert({
    where: { ocid },
    create: {
      ocid,
      latestReleaseId: storedRelease.id,
      title: tender.title ? String(tender.title) : undefined,
      description: tender.description ? String(tender.description) : undefined,
      status: tender.status ? String(tender.status) : undefined,
      category: tender.category ? String(tender.category) : undefined,
      province: tender.province ? String(tender.province) : undefined,
      procurementMethod: tender.procurementMethod ? String(tender.procurementMethod) : undefined,
      procurementMethodDetails: tender.procurementMethodDetails ? String(tender.procurementMethodDetails) : undefined,
      mainProcurementCategory: tender.mainProcurementCategory ? String(tender.mainProcurementCategory) : undefined,
      publishedDate: date(tender.datePublished),
      closingDate: date(tender.tenderPeriod?.end),
      enquiryStart: date(tender.enquiryPeriod?.start),
      enquiryEnd: date(tender.enquiryPeriod?.end),
      awardStart: date(tender.awardPeriod?.start),
      awardEnd: date(tender.awardPeriod?.end),
      valueAmount: decimal(tender.value?.amount),
      valueCurrency: tender.value?.currency ? String(tender.value.currency) : undefined,
      buyerId: buyer?.id,
      procuringEntityId: procuringEntity?.id,
      rawJson: tender
    },
    update: {
      latestReleaseId: storedRelease.id,
      title: tender.title ? String(tender.title) : undefined,
      description: tender.description ? String(tender.description) : undefined,
      status: tender.status ? String(tender.status) : undefined,
      category: tender.category ? String(tender.category) : undefined,
      province: tender.province ? String(tender.province) : undefined,
      procurementMethod: tender.procurementMethod ? String(tender.procurementMethod) : undefined,
      procurementMethodDetails: tender.procurementMethodDetails ? String(tender.procurementMethodDetails) : undefined,
      mainProcurementCategory: tender.mainProcurementCategory ? String(tender.mainProcurementCategory) : undefined,
      publishedDate: date(tender.datePublished),
      closingDate: date(tender.tenderPeriod?.end),
      enquiryStart: date(tender.enquiryPeriod?.start),
      enquiryEnd: date(tender.enquiryPeriod?.end),
      awardStart: date(tender.awardPeriod?.start),
      awardEnd: date(tender.awardPeriod?.end),
      valueAmount: decimal(tender.value?.amount),
      valueCurrency: tender.value?.currency ? String(tender.value.currency) : undefined,
      buyerId: buyer?.id,
      procuringEntityId: procuringEntity?.id,
      rawJson: tender
    }
  });

  for (const item of Array.isArray(tender.items) ? tender.items : []) {
    const itemId = item.id ? String(item.id) : undefined;
    if (!itemId) continue;
    await db.tenderItem.upsert({
      where: { tenderId_itemId: { tenderId: tenderRecord.id, itemId } },
      create: {
        tenderId: tenderRecord.id,
        itemId,
        description: item.description ? String(item.description) : undefined,
        quantity: decimal(item.quantity),
        unit: json(item.unit),
        classification: json(item.classification),
        deliveryAddress: json(item.deliveryAddress),
        deliveryPeriod: json(item.deliveryPeriod)
      },
      update: {
        description: item.description ? String(item.description) : undefined,
        quantity: decimal(item.quantity),
        unit: json(item.unit),
        classification: json(item.classification),
        deliveryAddress: json(item.deliveryAddress),
        deliveryPeriod: json(item.deliveryPeriod)
      }
    });
  }

  for (const doc of Array.isArray(tender.documents) ? tender.documents : []) {
    const documentId = doc.id ? String(doc.id) : undefined;
    if (!documentId) continue;
    await db.document.upsert({
      where: { tenderId_documentId: { tenderId: tenderRecord.id, documentId } },
      create: {
        tenderId: tenderRecord.id,
        documentId,
        documentType: doc.documentType ? String(doc.documentType) : undefined,
        title: doc.title ? String(doc.title) : undefined,
        description: doc.description ? String(doc.description) : undefined,
        format: doc.format ? String(doc.format) : undefined,
        url: doc.url ? String(doc.url) : undefined,
        datePublished: date(doc.datePublished),
        dateModified: date(doc.dateModified)
      },
      update: {
        documentType: doc.documentType ? String(doc.documentType) : undefined,
        title: doc.title ? String(doc.title) : undefined,
        description: doc.description ? String(doc.description) : undefined,
        format: doc.format ? String(doc.format) : undefined,
        url: doc.url ? String(doc.url) : undefined,
        datePublished: date(doc.datePublished),
        dateModified: date(doc.dateModified)
      }
    });
  }

  for (const lot of Array.isArray(tender.lots) ? tender.lots : []) {
    const lotId = lot.id ? String(lot.id) : undefined;
    if (!lotId) continue;
    await db.lot.upsert({
      where: { tenderId_lotId: { tenderId: tenderRecord.id, lotId } },
      create: {
        tenderId: tenderRecord.id,
        lotId,
        title: lot.title ? String(lot.title) : undefined,
        description: lot.description ? String(lot.description) : undefined,
        valueAmount: decimal(lot.value?.amount),
        currency: lot.value?.currency ? String(lot.value.currency) : undefined
      },
      update: {
        title: lot.title ? String(lot.title) : undefined,
        description: lot.description ? String(lot.description) : undefined,
        valueAmount: decimal(lot.value?.amount),
        currency: lot.value?.currency ? String(lot.value.currency) : undefined
      }
    });
  }

  await db.tender.update({
    where: { id: tenderRecord.id },
    data: {
      rawJson: tender,
      latestReleaseId: storedRelease.id
    }
  });
}

export async function runBackfill(dateFrom: Date, dateTo: Date) {
  const run = await db.ingestionRun.create({
    data: { source: 'etenders-ocds', dateFrom, dateTo, pageSize: PAGE_SIZE }
  });

  let page = 1;
  let releases = 0;
  let succeeded = 0;

  try {
    while (page <= MAX_PAGES) {
      const pack = await fetchReleases({
        pageNumber: page,
        pageSize: PAGE_SIZE,
        dateFrom: dateFrom.toISOString(),
        dateTo: dateTo.toISOString()
      });
      const pageReleases = Array.isArray(pack.releases) ? pack.releases : [];
      if (pageReleases.length === 0) break;

      for (const release of pageReleases) {
        releases++;
        try {
          await ingestRelease(release);
          succeeded++;
        } catch (error) {
          await db.ingestionError.create({
            data: {
              ingestionRunId: run.id,
              endpoint: '/api/OCDSReleases',
              page,
              releaseId: release.id ? String(release.id) : undefined,
              message: error instanceof Error ? error.message : String(error),
              payload: release
            }
          });
        }
      }

      await db.ingestionRun.update({
        where: { id: run.id },
        data: { pages: page, releases, succeeded, failed: releases - succeeded }
      });
      if (pageReleases.length < PAGE_SIZE) break;
      page++;
    }

    await db.ingestionRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'completed',
        pages: page,
        releases,
        succeeded,
        failed: releases - succeeded,
        checkpoint: page
      }
    });
  } catch (error) {
    await db.ingestionRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'failed',
        pages: page,
        releases,
        succeeded,
        failed: releases - succeeded,
        checkpoint: page,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  runBackfill(from, to)
    .then(async () => db.$disconnect())
    .catch(async (error) => {
      console.error(error);
      await db.$disconnect();
      process.exit(1);
    });
}
