/**
 * Metric catalog for badge rule builder UI.
 *
 * Derived from:
 * - reward-service: UserPointTransaction, GreenPointTransaction
 * - incident-service (logical keys): Report, Vote, Campaign, CampaignTask,
 *   CampaignJoiningRequest
 *
 * Keys use snake_case and align with badge evaluator `target` strings where applicable.
 * Columns map to Prisma field names (camelCase) used by aggregations when wired server-side.
 */
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

export type MetricTableSeed = {
  key: string;
  label: string;
  description?: string;
  columns: Array<{ key: string; label: string; valueType: string }>;
};

/** Meaningful user-activity metrics only (countable ids / numeric business fields). */
export const METRIC_METADATA_SEED: MetricTableSeed[] = [
  {
    key: "user_point_transactions",
    label: "User Point Transactions",
    description:
      "Unified RP/SP ledger (reward-service `UserPointTransaction`). Column keys match Prisma field names.",
    columns: [
      { key: "id", label: "Transaction Id", valueType: "integer" },
      { key: "amount", label: "Amount", valueType: "integer" },
    ],
  },
  {
    key: "green_point_transactions",
    label: "Green Point Transactions",
    description:
      "Legacy green-point ledger (reward-service `GreenPointTransaction`).",
    columns: [
      { key: "id", label: "Transaction Id", valueType: "integer" },
      { key: "points", label: "Points", valueType: "integer" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    description:
      "Environmental reports (incident-service `Report`). Evaluate via cross-service worker when wired.",
    columns: [
      { key: "id", label: "Report Id", valueType: "integer" },
      { key: "severityLevel", label: "Severity Level", valueType: "integer" },
      { key: "campaignId", label: "Campaign Id", valueType: "integer" },
      { key: "status", label: "Status Code", valueType: "integer" },
    ],
  },
  {
    key: "votes",
    label: "Votes",
    description: "Votes (incident-service `Vote`). One row per user/resource pair.",
    columns: [
      { key: "id", label: "Vote Id", valueType: "integer" },
      { key: "value", label: "Vote Value", valueType: "integer" },
      { key: "resourceId", label: "Resource Id", valueType: "integer" },
    ],
  },
  {
    key: "campaigns",
    label: "Campaigns",
    description: "Campaigns (incident-service `Campaign`).",
    columns: [
      { key: "id", label: "Campaign Id", valueType: "integer" },
      { key: "status", label: "Status Code", valueType: "integer" },
      { key: "difficulty", label: "Difficulty Level", valueType: "integer" },
    ],
  },
  {
    key: "campaign_tasks",
    label: "Campaign Tasks",
    description: "Campaign tasks (incident-service `CampaignTask`).",
    columns: [
      { key: "id", label: "Task Id", valueType: "integer" },
      { key: "priority", label: "Priority", valueType: "integer" },
      { key: "status", label: "Status Code", valueType: "integer" },
      { key: "campaignId", label: "Campaign Id", valueType: "integer" },
    ],
  },
  {
    key: "campaign_joining_requests",
    label: "Campaign Joining Requests",
    description:
      "Volunteer join requests (incident-service `CampaignJoiningRequest`). Filter by volunteerId.",
    columns: [
      { key: "id", label: "Request Id", valueType: "integer" },
      { key: "status", label: "Status Code", valueType: "integer" },
      { key: "campaignId", label: "Campaign Id", valueType: "integer" },
    ],
  },
  {
    key: "campaign_attendance_check_ins",
    label: "Campaign Check-Ins",
    description:
      "QR attendance (incident-service `CampaignAttendanceCheckIn`). Filter by userId.",
    columns: [{ key: "id", label: "Check-In Id", valueType: "integer" }],
  },
  {
    key: "orders",
    label: "Orders",
    description:
      "Reserved for future commerce integration (no Prisma model in DA2 yet).",
    columns: [
      { key: "id", label: "Order Id", valueType: "integer" },
      { key: "totalAmount", label: "Total Amount", valueType: "number" },
    ],
  },
  {
    key: "reviews",
    label: "Reviews",
    description:
      "Reserved for future reviews entity (no Prisma model in DA2 yet).",
    columns: [
      { key: "id", label: "Review Id", valueType: "integer" },
      { key: "rating", label: "Rating", valueType: "integer" },
    ],
  },
];

export async function seedMetricMetadata(prisma: PrismaClient): Promise<void> {
  for (const table of METRIC_METADATA_SEED) {
    const row = await prisma.metricTable.upsert({
      where: { key: table.key },
      create: {
        id: randomUUID(),
        key: table.key,
        label: table.label,
        description: table.description ?? null,
        isActive: true,
      },
      update: {
        label: table.label,
        description: table.description ?? null,
        isActive: true,
      },
    });

    for (const col of table.columns) {
      await prisma.metricColumn.upsert({
        where: {
          tableId_key: { tableId: row.id, key: col.key },
        },
        create: {
          id: randomUUID(),
          tableId: row.id,
          key: col.key,
          label: col.label,
          valueType: col.valueType,
          isActive: true,
        },
        update: {
          label: col.label,
          valueType: col.valueType,
          isActive: true,
        },
      });
    }
  }

  console.log(
    `Reward-service: metric metadata seeded (${METRIC_METADATA_SEED.length} tables).`,
  );
}
