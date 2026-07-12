#!/usr/bin/env bash
# Deploy hae-receiver to Cloud Run.
#
# Prereqs:
#   - GCP_PROJECT_ID environment variable set (required)
#   - Optional: GCP_REGION (default: asia-northeast1), BQ_DATASET (default: health)
#   - APIs enabled: run.googleapis.com, secretmanager.googleapis.com, bigquery.googleapis.com
#   - Secret 'hae-receiver-token' created (same value configured on HAE Pro side)
#   - Secret 'owntracks-auth-password' created (same value configured on OwnTracks side)
#   - Cloud Run default compute SA has:
#       roles/bigquery.dataEditor, roles/secretmanager.secretAccessor
#
# Usage: GCP_PROJECT_ID=your-project bash deploy.sh
set -euo pipefail

PROJECT_ID=${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}
REGION=${GCP_REGION:-asia-northeast1}
DATASET=${BQ_DATASET:-health}
OWNTRACKS_USERNAME=${OWNTRACKS_AUTH_USERNAME:-location}
SERVICE=hae-receiver

echo "[deploy] Deploying $SERVICE to $REGION (project=$PROJECT_ID, dataset=$DATASET)..."

gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source=. \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,BQ_DATASET=$DATASET,OWNTRACKS_AUTH_USERNAME=$OWNTRACKS_USERNAME" \
  --memory=1Gi \
  --cpu=1 \
  --concurrency=5 \
  --max-instances=3 \
  --timeout=300s

echo ""
echo "[deploy] Done. Service URL (point HAE Pro Automation at this):"
gcloud run services describe "$SERVICE" \
  --project="$PROJECT_ID" --region="$REGION" \
  --format="value(status.url)"
