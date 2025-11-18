#!/bin/bash

# Simple deployment script for Krapral Bot to Google Cloud Run
# This version uses environment variables directly (easier for first-time setup)
# Usage: ./deploy-simple.sh [project-id] [region] [telegram-token] [grok-key] [openai-key]

set -e

PROJECT_ID=${1:-${GOOGLE_CLOUD_PROJECT}}
REGION=${2:-us-central1}
TELEGRAM_TOKEN=${3}
GROK_KEY=${4}
OPENAI_KEY=${5}
SERVICE_NAME="krapral-bot"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: PROJECT_ID not set. Usage: ./deploy-simple.sh [project-id] [region] [telegram-token] [grok-key] [openai-key]"
  echo "Or set GOOGLE_CLOUD_PROJECT environment variable"
  exit 1
fi

if [ -z "$TELEGRAM_TOKEN" ] || [ -z "$GROK_KEY" ] || [ -z "$OPENAI_KEY" ]; then
  echo "Error: Missing API keys. Usage: ./deploy-simple.sh [project-id] [region] [telegram-token] [grok-key] [openai-key]"
  exit 1
fi

echo "🚀 Deploying Krapral Bot to Google Cloud Run"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Service: $SERVICE_NAME"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "Error: gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Check if docker is installed
if ! command -v docker &> /dev/null; then
  echo "Error: Docker not found. Install it from https://docs.docker.com/get-docker/"
  exit 1
fi

# Set the project
echo "📋 Setting GCP project..."
gcloud config set project $PROJECT_ID

# Enable required APIs
echo "🔧 Enabling required APIs..."
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com

# Build the Docker image
echo "🏗️  Building Docker image..."
docker build -t $IMAGE_NAME:latest .

# Configure Docker to use gcloud as credential helper
echo "🔐 Configuring Docker authentication..."
gcloud auth configure-docker

# Push to Container Registry
echo "📤 Pushing image to Container Registry..."
docker push $IMAGE_NAME:latest

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
  --set-env-vars "TELEGRAM_TOKEN=$TELEGRAM_TOKEN,GROK_API_KEY=$GROK_KEY,OPENAI_API_KEY=$OPENAI_KEY,NODE_ENV=production"

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📝 View logs:"
echo "   gcloud run services logs read $SERVICE_NAME --region $REGION --follow"
echo ""
echo "🌐 Service URL:"
gcloud run services describe $SERVICE_NAME --region $REGION --format="value(status.url)"
echo ""

