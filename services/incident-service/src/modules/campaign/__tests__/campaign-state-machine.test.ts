import { CampaignStatus } from "@da2/constants";
import {
  assertTransitionAllowed,
  findTransition,
  transitionCampaign,
} from "../campaign-state-machine";

const S = CampaignStatus;
const code = (c: string) =>
  expect.objectContaining({ statusResponse: expect.objectContaining({ code: c }) });

describe("assertTransitionAllowed", () => {
  it.each([
    ["submit", S.DRAFT, "manager"],
    ["resubmit", S.NEEDS_REVISION, "manager"],
    ["approve", S.PENDING_REVIEW, "admin"],
    ["start", S.UPCOMING, "system"],
    ["ban", S.UPCOMING, "admin"],
    ["ban", S.ACTIVE, "admin"],
    ["expire", S.PENDING_REVIEW, "system"],
    ["expire", S.NEEDS_REVISION, "system"],
    ["submit_completion", S.ACTIVE, "manager"],
    ["approve_completion", S.PENDING_COMPLETION, "admin"],
  ] as const)("%s from %i by %s is allowed", (event, fromStatus, actor) => {
    expect(() =>
      assertTransitionAllowed({ event, fromStatus, actor, reason: "x" }),
    ).not.toThrow();
  });

  it.each([
    ["approve", S.DRAFT],
    ["approve", S.NEEDS_REVISION],
    ["approve", S.BLOCKED], // blocking is permanent
    ["submit", S.PENDING_REVIEW],
    ["request_revision", S.ACTIVE],
    ["expire", S.ACTIVE],
    ["start", S.PENDING_REVIEW],
    ["submit_completion", S.UPCOMING],
  ] as const)("%s from %i is an invalid transition", (event, fromStatus) => {
    expect(() =>
      assertTransitionAllowed({ event, fromStatus, actor: "admin", reason: "x" }),
    ).toThrow(code("CAMPAIGN_INVALID_TRANSITION"));
  });

  it("approval opens the campaign as upcoming", () => {
    expect(findTransition("approve").to).toBe(S.UPCOMING);
    expect(findTransition("start").to).toBe(S.ACTIVE);
  });

  it("a manager cannot approve their own campaign", () => {
    expect(() =>
      assertTransitionAllowed({
        event: "approve",
        fromStatus: S.PENDING_REVIEW,
        actor: "manager",
      }),
    ).toThrow(code("CAMPAIGN_PERMISSION_DENIED"));
  });

  it.each(["request_revision", "block"] as const)("%s needs a reason", (event) => {
    expect(() =>
      assertTransitionAllowed({
        event,
        fromStatus: S.PENDING_REVIEW,
        actor: "admin",
        reason: "  ",
      }),
    ).toThrow(code("VALIDATION_ERROR"));
  });
});

describe("transitionCampaign", () => {
  const tx = () => ({
    campaign: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    campaignStatusLog: { create: jest.fn().mockResolvedValue({}) },
  });

  it("updates with compare-and-set and writes the log", async () => {
    const t = tx();
    const to = await transitionCampaign(t as never, {
      campaignId: "c1",
      event: "request_revision",
      fromStatus: S.PENDING_REVIEW,
      actor: "admin",
      actorId: "a1",
      reason: " fix the time ",
    });
    expect(to).toBe(S.NEEDS_REVISION);
    expect(t.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: S.PENDING_REVIEW, deletedAt: null },
      data: { status: S.NEEDS_REVISION, updatedBy: "a1" },
    });
    expect(t.campaignStatusLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "STATUS_CHANGE",
        event: "request_revision",
        fromStatus: S.PENDING_REVIEW,
        toStatus: S.NEEDS_REVISION,
        actorRole: "admin",
        reason: "fix the time",
      }),
    });
  });

  it("fails when the status changed meanwhile", async () => {
    const t = tx();
    t.campaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      transitionCampaign(t as never, {
        campaignId: "c1",
        event: "approve",
        fromStatus: S.PENDING_REVIEW,
        actor: "admin",
        actorId: "a1",
      }),
    ).rejects.toEqual(code("CAMPAIGN_INVALID_TRANSITION"));
    expect(t.campaignStatusLog.create).not.toHaveBeenCalled();
  });
});
