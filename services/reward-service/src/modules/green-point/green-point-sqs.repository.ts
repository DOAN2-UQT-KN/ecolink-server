import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { ReceivedGreenPointMessage } from "./green-point.types";

export class GreenPointSqsRepository {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor() {
    const region = process.env.AWS_REGION || "us-east-1";
    const queueUrl = process.env.SQS_GREEN_POINT_QUEUE_URL;
    const endpoint =
      process.env.AWS_GREENPOINT_ENDPOINT_URL ||
      process.env.AWS_SQS_ENDPOINT ||
      process.env.AWS_ENDPOINT_URL;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || "test";
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || "test";

    if (!queueUrl) {
      throw new Error("SQS_GREEN_POINT_QUEUE_URL is not configured");
    }

    this.client = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    this.queueUrl = queueUrl;
  }

  async sendMessage(body: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: body,
      }),
    );
  }

  async receiveMessages(
    maxNumberOfMessages: number,
    waitTimeSeconds: number,
    visibilityTimeoutSeconds: number,
  ): Promise<ReceivedGreenPointMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: maxNumberOfMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    if (!response.Messages || response.Messages.length === 0) {
      return [];
    }

    return response.Messages.flatMap((message: Message) => {
      if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
        return [];
      }
      const count = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
      return [
        {
          messageId: message.MessageId,
          receiptHandle: message.ReceiptHandle,
          body: message.Body,
          receiveCount: Number.isNaN(count) ? 1 : count,
        },
      ];
    });
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async scheduleRetry(
    receiptHandle: string,
    delaySeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.floor(delaySeconds)),
      }),
    );
  }
}

let singleton: GreenPointSqsRepository | null = null;

export function getGreenPointSqsRepository(): GreenPointSqsRepository {
  if (!singleton) {
    singleton = new GreenPointSqsRepository();
  }
  return singleton;
}
