# Rollback Reference

## Deployment History

| Version | Git Commit | Image Digest | Description | Deployed |
|---------|-----------|-------------|-------------|----------|
| **v3.2 (current)** | *pending* | *pending* | Bug fixes, reaction-only mode, sticker handler, reply-to context, GCS optimization | 2026-03-03 |
| **v3.1 (previous)** | `af20ca5` | `41210d081a98` | Grok primary + OpenAI fallback | 2026-03-03 |
| **v3.0** | — | `81a1c840a32b` | Last deploy before Grok (OpenAI-only) | 2026-01-22 |
| **new-branch-release** | — | `167e0f23051e` | — | 2026-01-16 |
| **final-release** | — | `1094f7786838` | — | 2026-01-15 |

## How to Rollback

### Option 1: Redeploy previous container image (fastest, no git changes)
```bash
# Roll back to pre-Grok version (Jan 22):
gcloud run deploy krapral-bot \
  --image gcr.io/vladomarenko/krapral-bot@sha256:81a1c840a32b2d21e701b5afa1bb0de14456bb026b0ab11f0a7c71f7001aa304 \
  --region europe-west1 \
  --platform managed

# List all available images:
gcloud container images list-tags gcr.io/vladomarenko/krapral-bot
```

### Option 2: Revert git commit and redeploy
```bash
git checkout main
git revert HEAD --no-edit
./deploy-cloud-build.sh
```

### Option 3: Reset git to specific commit and redeploy
```bash
git checkout main
git reset --hard COMMIT_HASH
./deploy-cloud-build.sh
```
