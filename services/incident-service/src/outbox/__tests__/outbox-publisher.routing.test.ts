import {
  resolveOutboxQueueUrl,
} from "../outbox-publisher";
import { OutboxEventType } from "../outbox.types";

describe("resolveOutboxQueueUrl", () => {
  const prevAi = process.env.SQS_AI_ANALYSIS_QUEUE_URL;
  const prevReward = process.env.SQS_REWARD_INTAKE_QUEUE_URL;
  const prevVerification = process.env.SQS_REPORT_VERIFICATION_QUEUE_URL;
  const prevEnabled = process.env.REPORT_VERIFICATION_ENABLED;

  beforeEach(() => {
    process.env.SQS_AI_ANALYSIS_QUEUE_URL =
      "http://localhost:4566/000000000000/ai-analysis-job";
    process.env.SQS_REWARD_INTAKE_QUEUE_URL =
      "http://localhost:4566/000000000000/reward-intake";
    process.env.SQS_REPORT_VERIFICATION_QUEUE_URL =
      "http://localhost:4566/000000000000/report-verification";
    delete process.env.REPORT_VERIFICATION_ENABLED;
  });

  afterAll(() => {
    if (prevAi === undefined) delete process.env.SQS_AI_ANALYSIS_QUEUE_URL;
    else process.env.SQS_AI_ANALYSIS_QUEUE_URL = prevAi;
    if (prevReward === undefined) delete process.env.SQS_REWARD_INTAKE_QUEUE_URL;
    else process.env.SQS_REWARD_INTAKE_QUEUE_URL = prevReward;
    if (prevVerification === undefined) delete process.env.SQS_REPORT_VERIFICATION_QUEUE_URL;
    else process.env.SQS_REPORT_VERIFICATION_QUEUE_URL = prevVerification;
    if (prevEnabled === undefined) delete process.env.REPORT_VERIFICATION_ENABLED;
    else process.env.REPORT_VERIFICATION_ENABLED = prevEnabled;
  });

  it("routes REPORT_SUBMITTED to AI analysis queue", () => {
    expect(resolveOutboxQueueUrl(OutboxEventType.REPORT_SUBMITTED)).toBe(
      process.env.SQS_AI_ANALYSIS_QUEUE_URL,
    );
  });

  it("routes green-point events to reward intake", () => {
    expect(
      resolveOutboxQueueUrl(OutboxEventType.REPORT_COMPLETION_GREEN_POINTS),
    ).toBe(process.env.SQS_REWARD_INTAKE_QUEUE_URL);
    expect(
      resolveOutboxQueueUrl(OutboxEventType.CAMPAIGN_COMPLETION_GREEN_POINTS),
    ).toBe(process.env.SQS_REWARD_INTAKE_QUEUE_URL);
    expect(
      resolveOutboxQueueUrl(OutboxEventType.REPORT_VOTE_MILESTONE_GREEN_POINTS),
    ).toBe(process.env.SQS_REWARD_INTAKE_QUEUE_URL);
  });

  it("throws when AI queue URL missing for REPORT_SUBMITTED", () => {
    delete process.env.SQS_AI_ANALYSIS_QUEUE_URL;
    expect(() =>
      resolveOutboxQueueUrl(OutboxEventType.REPORT_SUBMITTED),
    ).toThrow(/SQS_AI_ANALYSIS_QUEUE_URL/);
  });

  it("routes REPORT_SUBMITTED to report-verification when REPORT_VERIFICATION_ENABLED=true", () => {
    process.env.REPORT_VERIFICATION_ENABLED = "true";
    expect(resolveOutboxQueueUrl(OutboxEventType.REPORT_SUBMITTED)).toBe(
      process.env.SQS_REPORT_VERIFICATION_QUEUE_URL,
    );
  });

  it("throws when the verification queue URL is missing while enabled", () => {
    process.env.REPORT_VERIFICATION_ENABLED = "true";
    delete process.env.SQS_REPORT_VERIFICATION_QUEUE_URL;
    expect(() => resolveOutboxQueueUrl(OutboxEventType.REPORT_SUBMITTED)).toThrow(
      /SQS_REPORT_VERIFICATION_QUEUE_URL/,
    );
  });

  it("routes the report background jobs to their own queues (P10)", () => {
    const prevAnalysis = process.env.SQS_REPORT_ANALYSIS_QUEUE_URL;
    const prevTranslation = process.env.SQS_INCIDENT_TRANSLATION_QUEUE_URL;
    process.env.SQS_REPORT_ANALYSIS_QUEUE_URL = "http://localhost:4566/000000000000/report-analysis-job";
    process.env.SQS_INCIDENT_TRANSLATION_QUEUE_URL = "http://localhost:4566/000000000000/incident-translation";
    try {
      expect(resolveOutboxQueueUrl(OutboxEventType.ANALYZE_REPORT)).toBe(process.env.SQS_REPORT_ANALYSIS_QUEUE_URL);
      expect(resolveOutboxQueueUrl(OutboxEventType.TRANSLATE_TEXT)).toBe(process.env.SQS_INCIDENT_TRANSLATION_QUEUE_URL);
    } finally {
      if (prevAnalysis === undefined) delete process.env.SQS_REPORT_ANALYSIS_QUEUE_URL;
      else process.env.SQS_REPORT_ANALYSIS_QUEUE_URL = prevAnalysis;
      if (prevTranslation === undefined) delete process.env.SQS_INCIDENT_TRANSLATION_QUEUE_URL;
      else process.env.SQS_INCIDENT_TRANSLATION_QUEUE_URL = prevTranslation;
    }
  });
});
