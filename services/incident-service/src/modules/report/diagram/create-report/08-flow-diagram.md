# 8. Flow Diagram

`POST /api/v1/reports` — Client → Controller → Validation → Service → Database / External → Response.

**Tuần tự (HTTP):** auth → validate → download + EXIF (`prepareMediaFromUrl`, ngoài transaction) → transaction (`report` → `media` → `report_media_files` → `emitOutbox REPORT_SUBMITTED` → commit).

**Song song sau commit (không `await` queue):** kick-off `ANALYZE_REPORT` và `TRANSLATE_TEXT` rồi chạy `attachVotesToReports`. HTTP **không** đợi SQS / worker / duplicate. Trong `attachVotesToReports`, votes và saved chạy `Promise.all`; profile identity chạy sau khi hai query đó xong.

**Ngoài HTTP (sau commit):** `OutboxRelay` đẩy `REPORT_SUBMITTED` sang SQS AI. `ai-service` cascade SHA-256 → pHash → ORB (cùng `userId`, exclude report hiện tại). Nếu có ảnh trùng lặp, xóa hash và ORB của các ảnh duplicate, chỉ upsert các ảnh không trùng lặp còn lại (nếu có), rồi `PATCH /internal/v1/reports/:id/duplicate-verification` với body là mảng `{ duplicate_report_id, matches }[]`. Không chạy authenticity / risk. Duplicate **không** rollback report đã tạo. Nếu phát hiện trùng lặp (mảng không rỗng), `incident-service` tự động đặt `status = BANNED` (`_STATUS_INACTIVE`), lưu `rejectReason = DUPLICATE_IMAGE` và gửi thông báo cho chủ sở hữu báo cáo. GET report trả `duplicate_verification` (null trước khi worker ghi, `[]` nếu đã check và không trùng).

```mermaid
flowchart TD
  A[Client POST /api/v1/reports] --> B[camelCaseRequestBody]
  B --> C{authenticate JWT}
  C -->|no token| E1[401 TOKEN_MISSING]
  C -->|invalid| E2[401 TOKEN_INVALID]
  C -->|ok| D[express-validator bodies]
  D --> V{validationResult}
  V -->|errors| E3[400 VALIDATION_ERROR]
  V -->|ok| U{req.user.userId?}
  U -->|no| E4[401 UNAUTHORIZED]
  U -->|yes| S[ReportService.createReport]
  S --> PREP["Promise.all prepareMediaFromUrl"]
  PREP --> DL["download URL + EXIF"]
  DL -->|extract fail| KEEP["vẫn giữ url + capture"]
  DL -->|ok| META["mime size dims camera"]
  KEEP --> TX["prisma.$transaction"]
  META --> TX
  TX --> T1["report.create PENDING"]
  T1 --> T2["media.createMany"]
  T2 --> T3["reportMediaFile.createMany"]
  T3 --> T4["emitOutbox REPORT_SUBMITTED"]
  T4 --> CMT{commit}
  CMT -->|fail| E5[500 INTERNAL]
  CMT -->|ok| FORK[Sau commit: kick-off song song]

  FORK --> J1["enqueue ANALYZE_REPORT không await"]
  FORK --> TR["enqueueReportTranslationJob không await"]
  FORK --> EN["await toReportResponse + attachVotesToReports"]
  FORK -.-> RELAY["OutboxRelay claim REPORT_SUBMITTED"]

  J1 -->|fail| L1[log only]
  J1 --> W1["Worker ANALYZE_REPORT - ngoài HTTP"]
  L1 --> W1

  TR --> TRF{cleaned translations?}
  TRF -->|empty| SKIP["không enqueue TRANSLATE"]
  TRF -->|có field cần dịch| J2["enqueue TRANSLATE_TEXT"]
  J2 -->|fail SQS/store| L2["log only - không rollback"]
  J2 --> W2["Worker dịch - ngoài HTTP"]
  L2 --> W2

  EN --> PAR[Promise.all]
  PAR --> VOTES[votes]
  PAR --> SAVED[saved]
  VOTES --> PROF[attachReporterProfilesToReports]
  SAVED --> PROF
  PROF -->|throw| E6["500 nhưng report/media/outbox đã commit"]
  PROF -->|ok| R["201 CREATED + report"]

  RELAY --> SQS["SQS_AI_ANALYSIS_QUEUE"]
  SQS --> AI["ai-service handle REPORT_SUBMITTED"]
  AI --> HASH["download media + SHA256 + pHash"]
  HASH --> SHA{"exact SHA-256 cùng user?"}
  SHA -->|yes| HIT1["DUPLICATE_IMAGE + matches EXACT_HASH_MATCH"]
  SHA -->|no| PH{"pHash Hamming <= 10 cùng user?"}
  PH -->|yes| HIT2["DUPLICATE_IMAGE + matches HIGH_IMAGE_SIMILARITY"]
  PH -->|no| ORB{"ORB inliers pass?"}
  ORB -->|yes| HIT3["DUPLICATE_IMAGE + matches FEATURE_MATCH"]
  ORB -->|no| MISS["duplicate_report_ids empty, reason null"]
  HIT1 --> DEL["delete duplicate media hashes and ORB"]
  HIT2 --> DEL
  HIT3 --> DEL
  DEL --> FILTER["loại bỏ duplicate media"]
  FILTER --> REM{"còn ảnh hợp lệ?"}
  REM -->|yes| UPSERT["upsert non-duplicate hashes and ORB"]
  REM -->|no| PATCH["PATCH incident duplicate-verification"]
  MISS --> UPSERT_ALL["upsert all hashes and ORB"]
  UPSERT_ALL --> PATCH
  UPSERT --> PATCH
  PATCH --> SAVE["saveDuplicateVerification"]
  SAVE --> DUP{"array nonempty?"}
  DUP -->|yes| BAN["status = BANNED (INACTIVE) + reject_reason + notifyOwner"]
  DUP -->|no| KEEP_ST["giữ nguyên status"]
  BAN --> LOG["log DuplicateReportResult"]
  KEEP_ST --> LOG
```
