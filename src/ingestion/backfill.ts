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

async function upsertParty(party: any, roles: string[] = []) {
  if (!party) return undefined;
  const key = party.id ? { ocdsId: String(party.id) } : undefined;
  let record = key
    ? await db.party.findUnique({ where: key })
    : null;

  if (!record) {
    record = await db.party.create({
      data: {
        ocdsId: party.id ? String(party.id) : undefined,
        name: String(party.name ?? 'Unknown'),
        identifier: party.identifier?.id ? String(party.identifier.id) : undefined,
        partyType: party.roles?.[0] ? String(party.roles[0]) : undefined,
        address: party.address ?? undefined,
        contactPoint: party.contactPoint ?? undefined,
        raw: party
      }
    });
  } else {
    record = await db.party.update({
      where: { id: record.id },
      data: { name: String(party.name ?? record.name), raw: party }
    });
  }

  for (const role of roles) {
    await db.partyRole.upsert({
      where: { partyId_role: { partyId: record.id, role } },
      create: { partyId: record.id, role },
      update: {}
    });
  }
  return record;
}

async function ingestRelease(release: OcdsRelease) {
  const parties = Array.isArray(release.parties) ? release.parties : [];
  const buyerId = release.buyer?.id ? String(release.buyer.id) : undefined;
  const buyerParty = buyerId
    ? parties.find((p: any) => String(p.id) === buyerId)
    : undefined;
  const buyer = await upsertParty(buyerParty ?? release.buyer, ['buyer']);

  const storedRelease = await db.ocdsRelease.upsert({
    where: { id: String(release.id) },
    create: {
      id: String(release.id),
      ocid: String(release.ocid ?? release.id),
      date: date(release.date),
      tag: Array.isArray(release.tag) ? release.tag.map(String) : [],
      initiationType: release.initiationType ? String(release.initiationType) : undefined,
      language: release.language ? String(release.language) : undefined,
      raw: release,
      buyerId: buyer?.id,
      links: release.links ?? undefined
    },
    update: {
      date: date(release.date),
      tag: Array.isArray(release.tag) ? release.tag.map(String) : [],
      raw: release,
      buyerId: buyer?.id,
      links: release.links ?? undefined
    }
  });

  const tender = release.tender;
  if (tender && release.ocid) {
    const value = tender.value ?? {};
    const existing = await db.tender.findUnique({ where: { ocid: String(release.ocid) } });
    const tenderRecord = existing
      ? await db.tender.update({
          where: { id: existing.id },
          data: {
            latestReleaseId: storedRelease.id,
            title: tender.title ?? existing.title,
            description: tender.description ?? existing.description,
            status: tender.status ?? existing.status,
            procurementMethod: tender.procurementMethod ?? existing.procurementMethod,
            procurementMethodDetails: tender.procurementMethodDetails ?? existing.procurementMethodDetails,
            mainProcurementCategory: tender.mainProcurementCategory ?? existing.mainProcurementCategory,
            publishedDate: date(tender.datePublished) ?? existing.publishedDate,
            closingDate: date(tender.tenderPeriod?.end) ?? existing.closingDate,
            valueAmount: decimal(value.amount) ?? existing.valueAmount,
            valueCurrency: value.currency ? String(value.currency) : existing.valueCurrency,
            raw: tender
          }
        })
      : await db.tender.create({
          data: {
            ocid: String(release.ocid),
            latestReleaseId: storedRelease.id,
            title: tender.title ? String(tender.title) : undefined,
            description: tender.description ? String(tender.description) : undefined,
            status: tender.status ? String(tender.status) : undefined,
            procurementMethod: tender.procurementMethod ? String(tender.procurementMethod) : undefined,
            procurementMethodDetails: tender.procurementMethodDetails ? String(tender.procurementMethodDetails) : undefined,
            mainProcurementCategory: tender.mainProcurementCategory ? String(tender.mainProcurementCategory) : undefined,
            publishedDate: date(tender.datePublished),
            closingDate: date(tender.tenderPeriod?.end),
            valueAmount: decimal(value.amount),
            valueCurrency: value.currency ? String(value.currency) : undefined,
            raw: tender
          }
        });

    for (const item of Array.isArray(tender.items) ? tender.items : []) {
      await db.tenderItem.create({
        data: {
          tenderId: tenderRecord.id,
          itemId: item.id ? String(item.id) : undefined,
          description: item.description ? String(item.description) : undefined,
          quantity: decimal(item.quantity),
          unit: item.unit?.name ? String(item.unit.name) : undefined,
          classification: item.classification ?? undefined,
          deliveryAddress: item.deliveryAddress ?? undefined
        }
      });
    }

    for (const doc of Array.isArray(tender.documents) ? tender.documents : []) {
      await db.document.create({
        data: {
          tenderId: tenderRecord.id,
          documentId: doc.id ? String(doc.id) : undefined,
          documentType: doc.documentType ? String(doc.documentType) : undefined,
          title: doc.title ? String(doc.title) : undefined,
          format: doc.format ? String(doc.format) : undefined,
          url: doc.url ? String(doc.url) : undefined,
          datePublished: date(doc.datePublished)
        }
      });
    }

    for (const award of Array.isArray(release.awards) ? release.awards : []) {
      const createdAward = await db.award.create({
        data: {
          tenderId: tenderRecord.id,
          awardId: award.id ? String(award.id) : undefined,
          status: award.status ? String(award.status) : undefined,
          title: award.title ? String(award.title) : undefined,
          description: award.description ? String(award.description) : undefined,
          date: date(award.date),
          valueAmount: decimal(award.value?.amount),
          valueCurrency: award.value?.currency ? String(award.value.currency) : undefined,
          suppliers: award.suppliers ?? undefined,
          raw: award
        }
      });

      for (const contract of Array.isArray(release.contracts) ? release.contracts : []) {
        if (contract.awardID && award.id && String(contract.awardID) !== String(award.id)) continue;
        await db.contract.create({
          data: {
            tenderId: tenderRecord.id,
            awardId: createdAward.id,
            contractId: contract.id ? String(contract.id) : undefined,
            title: contract.title ? String(contract.title) : undefined,
            period: contract.period ?? undefined,
            valueAmount: decimal(contract.value?.amount),
            valueCurrency: contract.value?.currency ? String(contract.value.currency) : undefined,
            raw: contract
          }
        });
      }
    }
  }
}

export async function runBackfill(dateFrom: Date, dateTo: Date) {
  const run = await db.ingestionRun.create({
    data: { source: 'etenders-ocds', dateFrom, dateTo }
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

      await db.ingestionRun.update({ where: { id: run.id }, data: { pages: page, releases, succeeded } });
      if (pageReleases.length < PAGE_SIZE) break;
      page++;
    }

    await db.ingestionRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'completed', pages: page, releases, succeeded, failed: releases - succeeded }
    });
  } catch (error) {
    await db.ingestionRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'failed', pages: page, releases, succeeded, failed: releases - succeeded, error: error instanceof Error ? error.message : String(error) }
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
