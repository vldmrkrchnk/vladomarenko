#!/bin/bash

# Quick status check for Krapral Bot

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-vladomarenko}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE_NAME="krapral-bot"

echo "🔍 Checking Krapral Bot Status"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo ""

# Check service status
echo "📊 Service Status:"
gcloud run services describe $SERVICE_NAME \
  --region $REGION \
  --project $PROJECT_ID \
  --format="table(status.url,status.conditions[0].status,status.latestReadyRevisionName)" 2>/dev/null || echo "❌ Service not found"

echo ""
echo "🏥 Health Check:"
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --project $PROJECT_ID --format="value(status.url)" 2>/dev/null)
if [ -n "$SERVICE_URL" ]; then
  HEALTH=$(curl -s "$SERVICE_URL/health" 2>/dev/null)
  if [ -n "$HEALTH" ]; then
    echo "✅ Health endpoint: $HEALTH"
    echo "   URL: $SERVICE_URL"
  else
    echo "❌ Health check failed"
  fi
else
  echo "❌ Could not get service URL"
fi

echo ""
echo "📝 Recent Logs (last 5 entries):"
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME" \
  --limit 5 \
  --project $PROJECT_ID \
  --format="table(timestamp,textPayload,jsonPayload.message)" 2>/dev/null | head -10

echo ""
echo "💡 To view live logs:"
echo "   gcloud run services logs read $SERVICE_NAME --region $REGION --project $PROJECT_ID --follow"
echo ""
echo "💡 To test in Telegram:"
echo "   Send a message to your bot in Telegram and check if it responds!"

