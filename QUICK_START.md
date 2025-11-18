# Quick Start: Deploy to Google Cloud

## Prerequisites Check

1. **Install gcloud CLI** (if not installed):
   ```bash
   # macOS
   brew install google-cloud-sdk
   
   # Or download from: https://cloud.google.com/sdk/docs/install
   ```

2. **Login to Google Cloud:**
   ```bash
   gcloud auth login
   ```

3. **Create a project** (if you don't have one):
   ```bash
   gcloud projects create YOUR_PROJECT_ID
   gcloud config set project YOUR_PROJECT_ID
   ```

4. **Enable billing** for your project:
   - Go to: https://console.cloud.google.com/billing
   - Link a billing account to your project

## One-Command Deploy

```bash
./deploy-simple.sh YOUR_PROJECT_ID us-central1 YOUR_TELEGRAM_TOKEN YOUR_GROK_KEY YOUR_OPENAI_KEY
```

**Example:**
```bash
./deploy-simple.sh my-krapral-bot us-central1 123456789:ABCdefGHIjklMNOpqrsTUVwxyz grok_abc123 openai_sk-abc123
```

## What Happens

1. ✅ Builds Docker image
2. ✅ Pushes to Google Container Registry
3. ✅ Deploys to Cloud Run
4. ✅ Sets environment variables
5. ✅ Bot starts running 24/7

## Verify Deployment

```bash
# Check service status
gcloud run services describe krapral-bot --region us-central1

# View logs
gcloud run services logs read krapral-bot --region us-central1 --follow

# Test the bot in Telegram
```

## Next Steps

- **View logs**: `gcloud run services logs read krapral-bot --region us-central1 --follow`
- **Update bot**: Make changes, then run `./deploy-simple.sh` again
- **Monitor**: Check Cloud Run console for metrics
- **Set up Cloud Storage** (optional): For log file persistence, see [DEPLOYMENT.md](./DEPLOYMENT.md)

## Troubleshooting

**"Permission denied" on deploy script:**
```bash
chmod +x deploy-simple.sh
```

**"Project not found":**
```bash
gcloud projects list
gcloud config set project YOUR_PROJECT_ID
```

**"API not enabled":**
The script automatically enables required APIs, but if it fails:
```bash
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
```

**Bot not responding:**
- Check logs: `gcloud run services logs read krapral-bot --region us-central1`
- Verify environment variables are set correctly
- Test your API keys locally first

## Cost

- **Cloud Run**: ~$0.40/month for 1 instance (512Mi memory, 24/7)
- **Container Registry**: First 500MB free, then $0.026/GB/month
- **Total**: ~$0.50/month for a small bot

