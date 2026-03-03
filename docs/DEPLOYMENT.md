# Deployment Guide: Krapral Bot to Google Cloud

This guide covers deploying the Krapral Telegram Bot to Google Cloud Platform.

## Prerequisites

1. **Google Cloud Account** with billing enabled
2. **gcloud CLI** installed and configured: [Install Guide](https://cloud.google.com/sdk/docs/install)
3. **Docker** installed (for local builds): [Install Guide](https://docs.docker.com/get-docker/)
4. **API Keys** ready:
   - Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
   - Grok API Key (from [x.ai](https://x.ai))
   - OpenAI API Key (from [OpenAI](https://platform.openai.com))

## Option 1: Cloud Run (Recommended)

Cloud Run is serverless, scales automatically, and is cost-effective for bots.

### Quick Deploy (Simple - Environment Variables)

**Easiest way for first-time deployment:**

```bash
./deploy-simple.sh YOUR_PROJECT_ID us-central1 YOUR_TELEGRAM_TOKEN YOUR_GROK_KEY YOUR_OPENAI_KEY
```

This will:
- Build the Docker image
- Push to Container Registry
- Deploy to Cloud Run with environment variables set

### Quick Deploy (Advanced - Secret Manager)

1. **Set your project ID:**
   ```bash
   export GOOGLE_CLOUD_PROJECT=your-project-id
   ```

2. **Run the deployment script:**
   ```bash
   ./deploy.sh
   ```

3. **Set up secrets** (see Secret Manager section below)

### Manual Deploy

1. **Build and push the image:**
   ```bash
   # Set your project
   gcloud config set project YOUR_PROJECT_ID
   
   # Build the image
   docker build -t gcr.io/YOUR_PROJECT_ID/krapral-bot:latest .
   
   # Push to Container Registry
   docker push gcr.io/YOUR_PROJECT_ID/krapral-bot:latest
   ```

2. **Deploy to Cloud Run:**
   ```bash
   gcloud run deploy krapral-bot \
     --image gcr.io/YOUR_PROJECT_ID/krapral-bot:latest \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --memory 512Mi \
     --cpu 1 \
     --timeout 300 \
     --max-instances 1 \
     --set-env-vars "TELEGRAM_TOKEN=your_token,GROK_API_KEY=your_key,OPENAI_API_KEY=your_key,NODE_ENV=production"
   ```

### Using Secret Manager (Recommended for Production)

1. **Create secrets:**
   ```bash
   echo -n "your_telegram_token" | gcloud secrets create telegram-token --data-file=-
   echo -n "your_grok_key" | gcloud secrets create grok-api-key --data-file=-
   echo -n "your_openai_key" | gcloud secrets create openai-api-key --data-file=-
   ```

2. **Grant Cloud Run access:**
   ```bash
   PROJECT_NUMBER=$(gcloud projects describe $GOOGLE_CLOUD_PROJECT --format="value(projectNumber)")
   SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
   
   gcloud secrets add-iam-policy-binding telegram-token \
     --member="serviceAccount:${SERVICE_ACCOUNT}" \
     --role="roles/secretmanager.secretAccessor"
   
   gcloud secrets add-iam-policy-binding grok-api-key \
     --member="serviceAccount:${SERVICE_ACCOUNT}" \
     --role="roles/secretmanager.secretAccessor"
   
   gcloud secrets add-iam-policy-binding openai-api-key \
     --member="serviceAccount:${SERVICE_ACCOUNT}" \
     --role="roles/secretmanager.secretAccessor"
   ```

3. **Deploy with secrets:**
   ```bash
   gcloud run deploy krapral-bot \
     --image gcr.io/YOUR_PROJECT_ID/krapral-bot:latest \
     --platform managed \
     --region us-central1 \
     --set-secrets "TELEGRAM_TOKEN=telegram-token:latest,GROK_API_KEY=grok-api-key:latest,OPENAI_API_KEY=openai-api-key:latest" \
     --set-env-vars "NODE_ENV=production"
   ```

### View Logs

```bash
# Stream logs
gcloud run services logs read krapral-bot --region us-central1 --follow

# Or view in Console
# GCP Console → Cloud Run → krapral-bot → Logs
```

## Option 2: Compute Engine (VM)

For persistent file storage without Cloud Storage bucket.

### Setup

1. **Create a VM instance:**
   ```bash
   gcloud compute instances create krapral-bot-vm \
     --zone=us-central1-a \
     --machine-type=e2-micro \
     --image-family=cos-stable \
     --image-project=cos-cloud \
     --boot-disk-size=10GB
   ```

2. **SSH into the VM:**
   ```bash
   gcloud compute ssh krapral-bot-vm --zone=us-central1-a
   ```

3. **Install Node.js:**
   ```bash
   # On the VM
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

4. **Clone and deploy:**
   ```bash
   # On the VM
   git clone YOUR_REPO_URL
   cd Vladomarenko
   npm install
   npm run build
   
   # Create .env file
   nano .env
   # Add: TELEGRAM_TOKEN, GROK_API_KEY, OPENAI_API_KEY
   
   # Run with PM2
   npm install -g pm2
   pm2 start dist/bot.js --name krapral-bot
   pm2 save
   pm2 startup  # Follow instructions to enable on boot
   ```

## Option 3: Cloud Build (CI/CD)

Automated deployment on git push.

1. **Connect your repository** to Cloud Build
2. **Create a trigger** that uses `cloudbuild.yaml`
3. **Set substitution variables** in the trigger:
   - `_REGION=us-central1`
   - `_SERVICE_NAME=krapral-bot`

4. **Push to trigger deployment:**
   ```bash
   git push origin main
   ```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | Yes | Telegram bot token from BotFather |
| `GROK_API_KEY` | Yes | Grok API key from x.ai |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `NODE_ENV` | No | Set to `production` for JSON logging |
| `GCP_STORAGE_BUCKET` | No | GCS bucket name (only for Cloud Run/App Engine) |
| `BOT_MODE` | No | `dev` for console-only logging |

## Troubleshooting

### Bot not responding
- Check Cloud Run logs: `gcloud run services logs read krapral-bot --region us-central1`
- Verify environment variables are set correctly
- Check that `identity.txt` and `users.json` are in the container

### Container build fails
- Ensure `identity.txt` and `users.json` exist in project root
- Check Dockerfile paths are correct
- Verify `tsconfig.json` is present

### Permission errors
- For Secret Manager: Ensure service account has `secretmanager.secretAccessor` role
- For Cloud Storage: Ensure service account has `storage.objects.create` role

## Cost Estimation

- **Cloud Run**: ~$0.40/month for 1 instance running 24/7 (512Mi memory)
- **Cloud Storage** (optional): ~$0.02/GB/month
- **Cloud Logging**: First 50GB free, then $0.50/GB

## Next Steps

After deployment:
1. Test the bot in Telegram
2. Monitor logs for errors
3. Set up alerts in Cloud Monitoring
4. Configure log retention policies

