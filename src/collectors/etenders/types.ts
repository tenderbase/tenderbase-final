export type JsonObject = Record<string, unknown>;

export interface ReleasePackage {
  uri?: string;
  version?: string;
  publishedDate?: string;
  publisher?: JsonObject;
  license?: string;
  publicationPolicy?: string;
  releases?: Release[];
  links?: { next?: string; prev?: string };
}

export interface Release {
  ocid: string;
  id: string;
  date?: string;
  tag?: string[];
  description?: string;
  initiationType?: string;
  tender?: Tender;
  planning?: JsonObject;
  parties?: Party[];
  buyer?: JsonObject;
  language?: string;
  awards?: Award[];
  contracts?: Contract[];
  relatedProcesses?: RelatedProcess[];
}

export interface Tender {
  id?: string;
  title?: string;
  status?: string;
  category?: string;
  province?: string;
  deliveryLocation?: JsonObject;
  specialConditions?: string;
  mainProcurementCategory?: string;
  additionalProcurementCategories?: JsonObject[];
  description?: string;
  eligibilityCriteria?: string;
  submissionMethod?: string[];
  submissionMethodDetails?: string;
  classification?: JsonObject;
  value?: { amount?: number; currency?: string };
  lots?: Lot[];
  items?: TenderItem[];
  communication?: JsonObject;
  selectionCriteria?: string;
  documents?: Document[];
  otherRequirements?: JsonObject;
  contractTerms?: JsonObject;
  techniques?: JsonObject;
  awardPeriod?: Period;
  tenderPeriod?: Period;
  enquiryPeriod?: Period;
  legalBasis?: string;
  contractPeriod?: Period;
  tenderers?: JsonObject[];
  procuringEntity?: JsonObject;
  procurementMethod?: string;
  procurementMethodDetails?: string;
  briefingSession?: BriefingSession;
  contactPerson?: ContactPerson;
}

export interface Period { startDate?: string; endDate?: string; maxExtentDate?: string }
export interface Party { id?: string; name?: string; identifier?: JsonObject; address?: JsonObject; contactPoint?: JsonObject; roles?: string[] }
export interface Lot { id?: string; title?: string; description?: string; value?: { amount?: number; currency?: string } }
export interface TenderItem { id?: string; description?: string; quantity?: number; unit?: JsonObject; classification?: JsonObject; deliveryAddress?: JsonObject; deliveryPeriod?: Period }
export interface Document { id?: string; documentType?: string; title?: string; description?: string; format?: string; url?: string; datePublished?: string; dateModified?: string }
export interface BriefingSession { date?: string; venue?: string; address?: JsonObject }
export interface ContactPerson { name?: string; email?: string; telephone?: string; faxNumber?: string }
export interface Award { id?: string; status?: string; title?: string; description?: string; date?: string; value?: { amount?: number; currency?: string }; suppliers?: Party[] }
export interface Contract { id?: string; awardID?: string; title?: string; period?: Period; value?: { amount?: number; currency?: string }; documents?: Document[] }
export interface RelatedProcess { relationship?: string[]; identifier?: string; scheme?: string; uri?: string }
