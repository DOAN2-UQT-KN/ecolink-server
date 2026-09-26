import prisma from "../config/prisma.client";
import { organizationOwnerOnboardPublisher } from "../modules/organization_application/organization-owner-onboard.publisher";
import { OutboxRelay } from "./outbox-relay";
import {
  OutboxPublisher,
  RoutingOutboxPublisher,
  SqsOutboxPublisher,
} from "./outbox-publisher";
import { OutboxEventType } from "./outbox.types";

let relay: OutboxRelay | null = null;

/**
 * Composition root for the relay's transports. Kept here rather than inside `OutboxRelay`
 * so the outbox core stays free of feature-module imports.
 */
function buildPublisher(): OutboxPublisher {
  // The SQS client is only constructed if a reward event actually shows up, so a deployment
  // without queue configuration can still deliver owner onboarding emails.
  let sqs: OutboxPublisher | null = null;
  const lazySqs = (): OutboxPublisher => (sqs ??= new SqsOutboxPublisher());

  return new RoutingOutboxPublisher(
    {
      [OutboxEventType.ORG_OWNER_ONBOARD]: organizationOwnerOnboardPublisher,
    },
    lazySqs,
  );
}

export function startOutboxRelay(): void {
  if (process.env.OUTBOX_RELAY_ENABLED === "false") {
    console.log("[OutboxRelay] disabled via OUTBOX_RELAY_ENABLED=false");
    return;
  }
  if (relay) return;
  relay = new OutboxRelay(prisma, buildPublisher());
  relay.start();
}

export async function stopOutboxRelay(): Promise<void> {
  if (!relay) return;
  await relay.stop();
  relay = null;
}
