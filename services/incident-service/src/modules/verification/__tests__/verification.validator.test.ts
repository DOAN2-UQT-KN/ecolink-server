import { validationResult } from "express-validator";
import { moderateValidators, moderationQueueValidators } from "../verification.validator";

const ID = "8f1d7f4e-2a51-4c4b-9a0e-0d5f3b8e6c11";

async function errors(validators: { run(req: unknown): Promise<unknown> }[], req: Record<string, unknown>) {
  const full = { params: {}, query: {}, body: {}, ...req };
  await Promise.all(validators.map((v) => v.run(full)));
  return validationResult(full as never)
    .array()
    .map((e) => e.msg as string);
}

describe("moderation validators", () => {
  it("requires a reason code to reject", async () => {
    expect(await errors(moderateValidators, { params: { id: ID }, body: { decision: "REJECT" } })).toContain(
      "reason_code is required when rejecting",
    );
  });

  it("accepts ACCEPT without a reason code and REJECT with one", async () => {
    expect(await errors(moderateValidators, { params: { id: ID }, body: { decision: "ACCEPT" } })).toEqual([]);
    expect(
      await errors(moderateValidators, { params: { id: ID }, body: { decision: "REJECT", reasonCode: "NOT_ON_SITE" } }),
    ).toEqual([]);
  });

  it("limits the note to 5000 characters", async () => {
    const body = { decision: "ACCEPT", note: "x".repeat(5001) };
    expect(await errors(moderateValidators, { params: { id: ID }, body })).toContain(
      "note must be at most 5000 characters",
    );
  });

  it("validates the queue query", async () => {
    expect(await errors(moderationQueueValidators, { query: { flag: "FOO" } })).toContain(
      "flag must be REVIEW or REJECT",
    );
    expect(await errors(moderationQueueValidators, { query: { limit: "101" } })).toContain(
      "limit must be between 1 and 100",
    );
    expect(await errors(moderationQueueValidators, { query: { flag: "REJECT", page: "2", limit: "50" } })).toEqual([]);
  });
});
