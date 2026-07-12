#!/usr/bin/env bash
set -euo pipefail

# Deploy the non-billable BigQuery-only candidate discovery command as a
# Cloud Run Job using the latest hae-receiver image. Google Places lookup is
# deliberately not part of this job.

PROJECT_ID=${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}
REGION=${GCP_REGION:-asia-northeast1}
DATASET=${BQ_DATASET:-health}
SERVICE=${LOCATION_DISCOVERY_SOURCE_SERVICE:-hae-receiver}
JOB=${LOCATION_DISCOVERY_JOB:-location-place-discovery}
IMAGE_REPOSITORY="asia-northeast1-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE}"

case "$PROJECT_ID" in
  (*[!a-z0-9-]*|'') echo "Invalid GCP_PROJECT_ID" >&2; exit 2 ;;
esac
case "$DATASET" in
  (*[!A-Za-z0-9_]*|'') echo "Invalid BQ_DATASET" >&2; exit 2 ;;
esac

IMAGE="${LOCATION_DISCOVERY_IMAGE:-}"
if [[ -z "$IMAGE" ]]; then
  if IMAGE_DIGEST=$(gcloud artifacts docker images describe "${IMAGE_REPOSITORY}:latest" \
    --project="$PROJECT_ID" \
    --format='value(image_summary.digest)' 2>/dev/null); then
    :
  else
    IMAGE_DIGEST=""
  fi
  if [[ -n "$IMAGE_DIGEST" ]]; then
    IMAGE="${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"
  fi
fi

if [[ -z "$IMAGE" ]]; then
  IMAGE=$(gcloud run services describe "$SERVICE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='value(spec.template.spec.containers[0].image)')
fi

if [[ -z "$IMAGE" ]]; then
  echo "Could not find an image for Cloud Run service: $SERVICE" >&2
  exit 1
fi

args=(
  --image="$IMAGE"
  --region="$REGION"
  --command=node
  --args=dist/location-place-admin.js,discover
  --tasks=1
  --parallelism=1
  --max-retries=1
  --task-timeout=5m
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,BQ_DATASET=$DATASET,BQ_LOCATION=$REGION"
)

if [[ -n "${LOCATION_DISCOVERY_SERVICE_ACCOUNT:-}" ]]; then
  args+=(--service-account="$LOCATION_DISCOVERY_SERVICE_ACCOUNT")
fi

gcloud run jobs deploy "$JOB" \
  --project="$PROJECT_ID" \
  "${args[@]}"

echo "Job deployed: $JOB"
echo "Execute once: gcloud run jobs execute $JOB --project=$PROJECT_ID --region=$REGION --wait"
