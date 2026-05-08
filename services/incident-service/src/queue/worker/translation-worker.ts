import { QueueWorker } from "@da2/queue";
import type {
  BackgroundJobEnvelope,
  BackgroundJobQueue,
  QueueThresholdConfig,
} from "@da2/queue";
import {
  ReportJobType,
  TranslationJobPayload,
  TranslationResourceType,
} from "../../constants/job-type.enum";
import prisma from "../../config/prisma.client";
import { translateText } from "../../modules/translation/translation.client";

/**
 * Translates a batch of `(sourceText, vi/en field)` tuples and writes the
 * results back into the matching resource row. Runs in the dedicated
 * incident-translation SQS queue so request handlers no longer block on the
 * AI translation service.
 */
export class TranslationWorker extends QueueWorker {
  protected readonly jobType = ReportJobType.TRANSLATE_TEXT;

  constructor(
    queue: BackgroundJobQueue,
    store: ConstructorParameters<typeof QueueWorker>[1],
    threshold: QueueThresholdConfig,
  ) {
    super(queue, store, threshold);
  }

  protected override async process(
    body: string,
    _jobId: string,
  ): Promise<void> {
    const envelope = JSON.parse(
      body,
    ) as BackgroundJobEnvelope<TranslationJobPayload>;
    const payload = envelope.payload;

    if (
      !payload ||
      typeof payload.resourceId !== "string" ||
      !payload.resourceId ||
      !Array.isArray(payload.translations) ||
      payload.translations.length === 0
    ) {
      throw new Error("Invalid translation payload");
    }

    const updateData: Record<string, string> = {};
    for (const t of payload.translations) {
      if (
        typeof t.sourceText !== "string" ||
        !t.sourceText.trim() ||
        (!t.viField && !t.enField)
      ) {
        continue;
      }
      const result = await translateText(t.sourceText);
      if (t.viField) updateData[t.viField] = result.vi;
      if (t.enField) updateData[t.enField] = result.en;
    }

    if (Object.keys(updateData).length === 0) {
      return;
    }

    await this.applyUpdate(
      payload.resourceType,
      payload.resourceId,
      updateData,
    );
  }

  private async applyUpdate(
    resourceType: TranslationResourceType,
    resourceId: string,
    data: Record<string, string>,
  ): Promise<void> {
    switch (resourceType) {
      case TranslationResourceType.REPORT:
        await prisma.report.update({
          where: { id: resourceId },
          data: data as never,
        });
        return;
      case TranslationResourceType.ORGANIZATION:
        await prisma.organization.update({
          where: { id: resourceId },
          data: data as never,
        });
        return;
      default:
        throw new Error(
          `Unsupported translation resource type: ${String(resourceType)}`,
        );
    }
  }
}
