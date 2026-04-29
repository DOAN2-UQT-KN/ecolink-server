#!/bin/sh
# LocalStack runs scripts in /etc/localstack/init/ready.d when the container is ready.
# Idempotent: create-queue may fail if the queue already exists.
set -e
for name in durable-background-job notification-send green-point facebook-recognition ai-analysis-job report-analysis-job; do
  echo "Creating SQS queue: $name"
  awslocal sqs create-queue --queue-name "$name" || true
done
echo "SQS queues init done."
