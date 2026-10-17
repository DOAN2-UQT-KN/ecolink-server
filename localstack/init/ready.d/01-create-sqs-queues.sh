#!/bin/sh
# LocalStack runs scripts in /etc/localstack/init/ready.d when the container is ready.
# Idempotent: create-queue may fail if the queue already exists.
set -e
for name in durable-background-job notification-send green-point facebook-recognition reward-intake ai-analysis-job report-analysis-job incident-translation reward-translation notification-translation report-verification; do
  echo "Creating SQS queue: $name"
  awslocal sqs create-queue --queue-name "$name" || true
done
# report-verification (specs/006 P05): one message runs 3 checks x 10 s timeout, so keep it invisible longer.
awslocal sqs set-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name report-verification --query QueueUrl --output text)" \
  --attributes VisibilityTimeout=60 || true
echo "SQS queues init done."
