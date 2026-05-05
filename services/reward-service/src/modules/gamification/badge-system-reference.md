# Badge System Reference

## Enums

```ts
enum BadgeCategory {
  REPORT = "REPORT",
  CAMPAIGN = "CAMPAIGN",
  CONTRIBUTION = "CONTRIBUTION",
  RANK = "RANK",
}

enum BadgeRuleType {
  THRESHOLD = "THRESHOLD",
  RANK = "RANK",
}

enum LeaderboardMetric {
  CRP = "CRP",
  VRP = "VRP",
  REPORT_UPVOTES = "REPORT_UPVOTES",
  REPORT_COUNT = "REPORT_COUNT",
  CAMPAIGN_COMPLETED = "CAMPAIGN_COMPLETED",
}
```

## BadgeDefinition Shape

- `category`: groups metrics by feature area and drives metric validation.
- `ruleType`: determines which condition field is required.
- `metric`: score/rank signal to evaluate.
- `threshold`: used when `ruleType = THRESHOLD`.
- `rankTopN`: used when `ruleType = RANK`.
- `reward`: JSON benefits payload.

## Validation Rules

- `ruleType = THRESHOLD` -> `threshold` is required, non-negative integer, `rankTopN` must be null.
- `ruleType = RANK` -> `rankTopN` is required, positive integer, `threshold` must be null.
- Category/metric compatibility:
  - `REPORT` -> metric must start with `REPORT_`.
  - `CAMPAIGN` -> metric must start with `CAMPAIGN_`.
  - `CONTRIBUTION` -> metric must be `CRP` or `VRP`.
  - `RANK` -> `ruleType` must be `RANK`.

## Example Records

```json
[
  {
    "slug": "report_top_reporter_100_upvotes",
    "name": "Top Reporter",
    "category": "REPORT",
    "ruleType": "THRESHOLD",
    "metric": "REPORT_UPVOTES",
    "threshold": 100,
    "rankTopN": null,
    "reward": { "bonus_sp": 200 }
  },
  {
    "slug": "report_active_reporter_20_reports",
    "name": "Active Reporter",
    "category": "REPORT",
    "ruleType": "THRESHOLD",
    "metric": "REPORT_COUNT",
    "threshold": 20,
    "rankTopN": null,
    "reward": { "discount_bps": 300 }
  },
  {
    "slug": "campaign_volunteer_starter_5",
    "name": "Volunteer Starter",
    "category": "CAMPAIGN",
    "ruleType": "THRESHOLD",
    "metric": "CAMPAIGN_COMPLETED",
    "threshold": 5,
    "rankTopN": null,
    "reward": { "bonus_sp": 100 }
  }
]
```

## Naming Conventions

- Slug format: `<category>_<goal>_<qualifier>`, snake_case only.
- For threshold badges, include number in slug (`..._100_upvotes`, `..._20_reports`).
- For rank badges, include `top_n` in slug (`..._top_10_vrp`).
- Keep display name user-facing and short; keep slug machine-stable and immutable once published.

## Evaluation Logic

- Threshold evaluation:
  1. Load active threshold badges.
  2. Resolve current metric value for each badge.
  3. Grant badge when `value >= threshold`.
  4. Upsert by `(userId, badgeId, seasonId)` for idempotency.
- Rank evaluation:
  1. Load active rank badges.
  2. Read snapshot rank for each metric.
  3. Grant badge when `rank <= rankTopN`.
  4. Upsert by `(userId, badgeId, seasonId)` for idempotency.
