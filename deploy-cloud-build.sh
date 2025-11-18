#!/bin/bash

# Deployment script using Cloud Build (no local Docker required)
# Make sure your .env file has all required variables, then run: ./deploy-cloud-build.sh

set -e

# ============================================
# CONFIGURATION (can be overridden by .env)
# ============================================

# Google Cloud Project ID (default: vladomarenko)
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-vladomarenko}"

# Google Cloud Region (us-central1, us-east1, europe-west1, europe-west4, etc.)
# EU regions: europe-west1 (Belgium), europe-west4 (Netherlands), europe-west6 (Zurich)
REGION="${GCP_REGION:-europe-west1}"

# ============================================
# LOAD VARIABLES FROM .env FILE
# ============================================

if [ ! -f .env ]; then
  echo "❌ Error: .env file not found!"
  echo "   Please create a .env file with the following variables:"
  echo "   TELEGRAM_TOKEN=your_token"
  echo "   GROK_API_KEY=your_key"
  echo "   OPENAI_API_KEY=your_key"
  echo "   GCP_STORAGE_BUCKET=your-bucket (optional)"
  exit 1
fi

# Load .env file (export variables)
set -a
source .env
set +a

# Override PROJECT_ID and REGION from .env if set
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-${PROJECT_ID}}"
REGION="${GCP_REGION:-${REGION}}"

# ============================================
# DON'T EDIT BELOW THIS LINE
# ============================================

SERVICE_NAME="krapral-bot"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "🚀 Deploying Krapral Bot to Google Cloud Run (using Cloud Build)"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Service: $SERVICE_NAME"
echo ""

# Validate required variables from .env
if [ -z "$TELEGRAM_TOKEN" ]; then
  echo "❌ Error: TELEGRAM_TOKEN not set in .env file."
  exit 1
fi

if [ -z "$GROK_API_KEY" ]; then
  echo "❌ Error: GROK_API_KEY not set in .env file."
  exit 1
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "❌ Error: OPENAI_API_KEY not set in .env file."
  exit 1
fi

echo "✅ Loaded variables from .env file"
echo "   Project: $PROJECT_ID"
echo "   Region: $REGION"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "❌ Error: gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Set the project
echo "📋 Setting GCP project..."
gcloud config set project $PROJECT_ID

# Enable required APIs
echo "🔧 Enabling required APIs..."
gcloud services enable cloudbuild.googleapis.com --quiet
gcloud services enable run.googleapis.com --quiet
gcloud services enable containerregistry.googleapis.com --quiet

# Prepare environment variables for Cloud Run
ENV_VARS="TELEGRAM_TOKEN=$TELEGRAM_TOKEN,GROK_API_KEY=$GROK_API_KEY,OPENAI_API_KEY=$OPENAI_API_KEY,NODE_ENV=production"

# Add GCP_STORAGE_BUCKET if set
if [ -n "$GCP_STORAGE_BUCKET" ]; then
  ENV_VARS="$ENV_VARS,GCP_STORAGE_BUCKET=$GCP_STORAGE_BUCKET"
  echo "📦 Cloud Storage bucket configured: $GCP_STORAGE_BUCKET"
fi

# Build and deploy using Cloud Build
echo "🏗️  Building Docker image with Cloud Build (this may take a few minutes)..."
gcloud builds submit --tag $IMAGE_NAME:latest --project $PROJECT_ID

# Deploy to Cloud Run
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image $IMAGE_NAME:latest \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --max-instances 1 \
  --set-env-vars "$ENV_VARS" \
  --project $PROJECT_ID

# Get the service URL and set webhook
echo ""
echo "🔗 Setting up webhook..."
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)" --project $PROJECT_ID 2>/dev/null)
if [ -n "$SERVICE_URL" ]; then
  echo "   Service URL: $SERVICE_URL"
  echo "   Webhook URL: ${SERVICE_URL}/webhook"
  echo ""
  echo "   Updating Cloud Run with webhook URL..."
  gcloud run services update $SERVICE_NAME \
    --region $REGION \
    --update-env-vars "WEBHOOK_URL=$SERVICE_URL" \
    --project $PROJECT_ID \
    --quiet
  echo "   ✅ Webhook URL configured"
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📝 Next steps:"
echo "   View logs: gcloud run services logs read $SERVICE_NAME --region $REGION --follow"
echo ""
echo "🌐 Service URL:"
gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)" --project $PROJECT_ID 2>/dev/null || echo "   (Check Cloud Run console)"
echo ""

