# Quick Start: Deploy to Google Cloud

## Prerequisites

1. **gcloud CLI** installed and logged in:
   ```bash
   brew install google-cloud-sdk   # macOS
   gcloud auth login
   gcloud config set project vladomarenko
   ```

2. **`.env` file** in project root with all keys:
   ```env
   export TELEGRAM_TOKEN='...'
   export GROK_API_KEY='...'
   export OPENAI_API_KEY='...'
   export GCP_STORAGE_BUCKET='krapral-bot-logs-vladomarenko'
   ```

## Deploy

```bash
git checkout main
git merge develop
./deploy-cloud-build.sh
```

That's it. The script will:
1. Read API keys from `.env`
2. Build Docker image via Cloud Build (no local Docker needed)
3. Deploy to Cloud Run (europe-west1)
4. Configure webhook URL automatically

## Verify

```bash
# Check logs
gcloud run services logs read krapral-bot --region europe-west1 --follow

# Check service status
gcloud run services describe krapral-bot --region europe-west1 --format="value(status.url)"
```

## Rollback

See [ROLLBACK.md](./ROLLBACK.md) for rollback options and deployment history.

## Local Development

```bash
# Uses separate test bot token from .env.local
npm run dev:local
```

## Cost

- Cloud Run: ~$0.40/month (512Mi, 1 instance, 24/7)
- Container Registry: ~$0.03/month
