#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"

# Declare all queues here. Add new queue names to this array.
TARGET_QUEUES=(
  "durable-background-job"
)

if command -v awslocal >/dev/null 2>&1; then
  AWS_SQS_CMD=(awslocal sqs)
else
  if ! command -v aws >/dev/null 2>&1; then
    echo "Error: aws CLI not found. Install awscli or awslocal." >&2
    exit 1
  fi

  AWS_SQS_CMD=(aws --endpoint-url "$AWS_ENDPOINT_URL" --region "$AWS_REGION" sqs)
fi

create_queue() {
  local queue_name="$1"

  echo "Creating or reusing SQS queue: $queue_name"
  "${AWS_SQS_CMD[@]}" create-queue \
    --queue-name "$queue_name" \
    --attributes VisibilityTimeout=120,ReceiveMessageWaitTimeSeconds=20 >/dev/null

  local queue_url
  queue_url="$("${AWS_SQS_CMD[@]}" get-queue-url --queue-name "$queue_name" --query 'QueueUrl' --output text)"

  echo "Queue ready: $queue_url"
  echo "$queue_name=$queue_url"

  # Produce an env-style key derived from queue name for copy/paste convenience.
  local env_key
  env_key="SQS_$(echo "$queue_name" | tr '[:lower:]-' '[:upper:]_')_URL"
  echo "$env_key=$queue_url"
  echo
}

for raw_queue_name in "${TARGET_QUEUES[@]}"; do
  queue_name="$(echo "$raw_queue_name" | xargs)"
  if [[ -z "$queue_name" ]]; then
    continue
  fi

  create_queue "$queue_name"
done

echo "Set incident-service env by copying one printed URL, for example:"
echo "SQS_REPORT_ANALYSIS_QUEUE_URL=<queue-url>"
