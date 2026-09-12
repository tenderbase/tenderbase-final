export type OcdsRelease = Record<string, any>;

export type OcdsPackage = {
  releases?: OcdsRelease[];
  links?: Record<string, unknown>;
  [key: string]: unknown;
};

const baseUrl = (process.env.ETENDERS_API_URL ?? 'https://ocds-api.etenders.gov.za').replace(/\/$/, '');

export async function fetchReleases(params: {
  pageNumber: number;
  pageSize: number;
  dateFrom: string;
  dateTo: string;
}): Promise<OcdsPackage> {
  const url = new URL(`${baseUrl}/api/OCDSReleases`);
  url.searchParams.set('PageNumber', String(params.pageNumber));
  url.searchParams.set('PageSize', String(params.pageSize));
  url.searchParams.set('dateFrom', params.dateFrom);
  url.searchParams.set('dateTo', params.dateTo);

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eTenders ${response.status}: ${body.slice(0, 1000)}`);
  }

  return response.json() as Promise<OcdsPackage>;
}
