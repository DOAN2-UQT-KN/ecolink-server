/**
 * Global numeric status set shared across DA2 services (reports, tasks, jobs, etc.).
 */
export enum GlobalStatus {
  _STATUS_ACTIVE = 1,
  _STATUS_INACTIVE = 2,
  _STATUS_DELETED = 3,
  _STATUS_DRAFT = 4,
  _STATUS_NEW = 5,
  _STATUS_WAITING_APPROVED = 6,
  _STATUS_WAITING_CONFIRMED = 7,
  _STATUS_REVIEWED = 8,
  _STATUS_INREVIEW = 9,
  _STATUS_ASSIGNED = 10,
  _STATUS_CANCELED = 11,
  _STATUS_PENDING = 12,
  _STATUS_VERIFIED = 13,
  _STATUS_APPROVED = 14,
  _STATUS_RECEIVED = 15,
  _STATUS_CONFIRMED = 16,
  _STATUS_COMPLETED = 17,
  _STATUS_REJECTED = 18,
  _STATUS_RETURNED = 19,
  _STATUS_OBSOLETE = 20,
  _STATUS_TODO = 21,
  _STATUS_INPROCESS = 22,
  _STATUS_FAILED = 23,
  _STATUS_CLOSED = 24,
  _STATUS_REPROCESS = 25,
}

export const ReportStatus = GlobalStatus;
export const TaskStatus = GlobalStatus;
export const JoinRequestStatus = GlobalStatus;
export const ResultStatus = GlobalStatus;

export enum MediaFileStage {
  BEFORE = "BEFORE",
  AFTER = "AFTER",
}

export enum MediaResourceType {
  REPORT = "REPORT",
  USER = "USER",
  REPORT_RESULT = "REPORT_RESULT",
  AI_PREDICT = "AI_PREDICT",
  OTHER = "OTHER",
}

/** Targets for user votes (reports, campaigns). Stored as lowercase in API and DB. */
export enum VoteResourceType {
  REPORT = "report",
  CAMPAIGN = "campaign",
}

/** Targets for saved / bookmarked resources. Stored as lowercase in API and DB. */
export enum SavedResourceType {
  REPORT = "report",
  CAMPAIGN = "campaign",
}

export const VoteValue = {
  NONE: 0,
  UP: 1,
  DOWN: -1,
} as const;

export class StatusValidator {
  static isValidStatus(status: number): boolean {
    return Object.values(GlobalStatus).includes(status as GlobalStatus);
  }

  static isValidReportStatus(status: number): boolean {
    return this.isValidStatus(status);
  }

  static isValidTaskStatus(status: number): boolean {
    return this.isValidStatus(status);
  }

  static isValidJoinRequestStatus(status: number): boolean {
    return this.isValidStatus(status);
  }

  static isValidResultStatus(status: number): boolean {
    return this.isValidStatus(status);
  }
}

export type GlobalStatusType = GlobalStatus;
export type ReportStatusType = GlobalStatus;
export type TaskStatusType = GlobalStatus;
export type JoinRequestStatusType = GlobalStatus;
export type ResultStatusType = GlobalStatus;
export type MediaFileStageType = `${MediaFileStage}`;
