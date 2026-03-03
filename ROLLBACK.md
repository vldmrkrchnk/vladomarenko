# Rollback Reference

## Current Production (GCloud)
- **Branch**: `main`
- **Commit**: `68d0aab` — "update bot checklist and identity structure for improved functionality and clarity"
- **Pre-Grok**: This is the last version running OpenAI-only (GPT-5.2 for all responses)

## How to Rollback

### Option 1: Redeploy old commit via Cloud Build
```bash
git checkout main
git reset --hard 68d0aab
git push --force origin main
# Cloud Build trigger will redeploy automatically
```

### Option 2: Redeploy old container image directly
```bash
# The image tagged with the short SHA should still be in Container Registry
gcloud run deploy krapral-bot \
  --image gcr.io/YOUR_PROJECT_ID/krapral-bot:68d0aab \
  --region us-central1 \
  --platform managed
```

### Option 3: Revert commit (safer — no force push)
```bash
git checkout main
git revert HEAD --no-edit   # Creates a new commit that undoes the last one
git push origin main
```
