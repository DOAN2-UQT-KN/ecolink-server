/** SQS envelope `jobType` for asynchronous translation work in reward-service. */
export const TRANSLATE_TEXT_JOB_TYPE = "TRANSLATE_TEXT" as const;

/** Logical resource types carried in TRANSLATE_TEXT payloads. */
export enum TranslationResourceType {
  GIFT = "GIFT",
  DIFFICULTY = "DIFFICULTY",
}

/**
 * Single translation request inside a TRANSLATE_TEXT job. The worker calls the
 * AI translation service for `sourceText` and writes the result into the named
 * Vietnamese / English columns. Either target may be omitted (e.g. when the
 * client already supplied one of the two languages).
 */
export interface TranslationFieldTarget {
  sourceText: string;
  viField?: string;
  enField?: string;
}

export interface TranslationJobPayload {
  resourceType: TranslationResourceType;
  resourceId: string;
  translations: TranslationFieldTarget[];
}
