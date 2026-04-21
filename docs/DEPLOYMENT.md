# Deploying Krapral Bot to Fly.io

The bot runs as a single always-on machine on Fly.io. One instance, 512 MB RAM, ~$2–4/month depending on region and usage.

If you're looking for the old Google Cloud Run instructions, see [DEPLOYMENT-GCLOUD.md](./DEPLOYMENT-GCLOUD.md).

## Prerequisites

- `flyctl` installed — `brew install flyctl` (macOS) or see https://fly.io/docs/flyctl/install/
- A Fly.io account — `fly auth signup` or `fly auth login`
- The three secrets ready to hand: `TELEGRAM_TOKEN`, `GROK_API_KEY`, `OPENAI_API_KEY`
- Optional: `GCP_STORAGE_BUCKET` if you want to keep writing logs to GCS

## First-time setup (one developer, once)

1. **Claim the app name**

   ```bash
   fly apps create krapral-bot
   ```

   If `krapral-bot` is already taken globally (Fly app names are global), pick another name and update the `app = '...'` line in `fly.toml`.

2. **Set secrets**

   Secrets are stored encrypted on Fly and injected as env vars at runtime.

   ```bash
   fly secrets set \
     TELEGRAM_TOKEN="..." \
     GROK_API_KEY="..." \
     OPENAI_API_KEY="..."
   ```

   Optional:

   ```bash
   fly secrets set GCP_STORAGE_BUCKET="your-bucket"
   ```

3. **Point Telegram's webhook at Fly**

   The bot reads `WEBHOOK_URL` and calls `setWebhook` on startup. Your Fly URL is `https://<app>.fly.dev`.

   ```bash
   fly secrets set WEBHOOK_URL="https://krapral-bot.fly.dev"
   ```

   (Replace `krapral-bot` with whatever app name you chose.)

4. **Deploy**

   ```bash
   fly deploy
   ```

   First deploy builds the Dockerfile remotely on Fly's builder, pushes the image, and boots one machine. Takes ~2–4 minutes.

5. **Verify**

   ```bash
   fly status           # machine should be "started"
   fly logs             # stream logs; look for "Webhook set to: ..."
   curl https://krapral-bot.fly.dev/health   # should return {"status":"ok",...}
   ```

   Then message the bot on Telegram to confirm it responds.

## Deploying a change (daily flow)

Assumes the first-time setup above is done and `krapral-bot` is live on Fly.

### What a developer does

1. **Work locally first.** Run `npm run dev:mode` against your own dev bot — see [DEVELOPMENT.md](./DEVELOPMENT.md). Never deploy code to prod that hasn't been tested against a dev bot.

2. **Make a branch and PR.** Branch off `main`, commit, open a PR against `main`, get review if the team requires it, merge.

3. **Pull and deploy.**
   ```bash
   git checkout main
   git pull
   fly deploy
   ```

   Fly builds the current working tree on a remote builder, pushes the image, rolls the machine to the new image, and runs health checks. Takes ~2–4 minutes. The CLI streams output; the last line will say `✓ deployed`.

4. **Verify.**
   ```bash
   fly status                          # machine is "started", check "passing"
   fly logs                            # look for "Webhook set to: ..." and no errors
   curl https://krapral-bot.fly.dev/health
   ```

   Then send a message to the bot in Telegram. It should reply.

5. **If something breaks, roll back immediately:**
   ```bash
   fly releases
   fly releases rollback <version>
   ```
   See [Rollback](#rollback) below.

### Who can deploy

Anyone with access to the Fly `krapral-bot` app. Invite a collaborator via the Fly dashboard (https://fly.io/dashboard → Members) or CLI:

```bash
fly orgs invite personal <email>
```

Each invited dev runs `fly auth login` locally to authenticate.

### Optional: auto-deploy on merge to `main` via GitHub Actions

Instead of `fly deploy` from each dev's machine, CI deploys on push to `main`. Setup:

1. Create a Fly deploy token:
   ```bash
   fly tokens create deploy -a krapral-bot
   ```
2. Add it to the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret** → name `FLY_API_TOKEN`, paste the token.
3. Add `.github/workflows/fly-deploy.yml`:
   ```yaml
   name: Deploy to Fly

   on:
     push:
       branches: [main]

   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: superfly/flyctl-actions/setup-flyctl@master
         - run: flyctl deploy --remote-only
           env:
             FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
   ```

After that, merging to `main` triggers a deploy. Devs don't need `flyctl` installed or Fly access — they just merge a PR.

### Canary / preview deploys

Not set up by default. If you want to test on prod-like infra without touching the live bot, create a separate Fly app (e.g. `fly apps create krapral-bot-staging`), give it its own `fly.toml` and its own Telegram dev token, and `fly deploy -c fly.staging.toml`.

## Managing secrets

```bash
fly secrets list                    # names only, values are never shown
fly secrets set FOO=bar             # set / update (triggers a deploy)
fly secrets unset FOO               # remove
```

Setting a secret auto-redeploys the machine. To stage multiple secret changes without multiple redeploys:

```bash
fly secrets set --stage FOO=1 BAR=2
fly deploy
```

## Logs

```bash
fly logs                     # tail live
fly logs --no-tail           # recent only
```

For historical logs beyond Fly's retention window, set `GCP_STORAGE_BUCKET` — the bot streams structured logs to GCS.

## Rollback

```bash
fly releases                  # list recent releases
fly releases rollback <version>   # roll the machine back to that image
```

Instant rollback — no rebuild needed, Fly keeps the old image.

## Scaling / cost

Default config in `fly.toml`:

- 1 `shared-cpu-1x` machine, 512 MB RAM
- `auto_stop_machines = 'off'` — machine stays up 24/7 (bots need this for webhooks)
- `min_machines_running = 1` — exactly one instance, no zero-downtime deploys but no duplicate Telegram responses either

Rough monthly cost: **$2–4/month** (shared-cpu-1x + 512 MB in `fra`). Check current pricing at https://fly.io/docs/about/pricing/.

To scale up (e.g. more memory for ffmpeg on heavier videos):

```bash
fly scale memory 1024       # bump to 1 GB
fly scale vm shared-cpu-2x  # bump CPU class
```

**Do not scale `count` above 1** — running two instances with the same Telegram webhook causes duplicate responses.

## Switching between webhook and polling

Webhook mode (default, what `fly.toml` sets up) requires the `WEBHOOK_URL` secret and Fly's public HTTPS endpoint.

To switch to polling mode (no public HTTPS needed, slightly simpler):

```bash
fly secrets unset WEBHOOK_URL
fly secrets set USE_WEBHOOK=false
```

The bot's startup logic (`src/bot.ts`) falls back to polling when `WEBHOOK_URL` is unset. Polling pulls updates from Telegram on a loop and is fine for low-traffic bots.

## Troubleshooting

**Deploy times out on health check**
- Check `fly logs` — is the HTTP server actually starting on port 8080?
- Confirm `internal_port = 8080` in `fly.toml` matches `PORT` in `src/bot.ts`

**Bot not replying in Telegram**
- `fly logs` for errors from Telegram API
- `curl https://<app>.fly.dev/health` — is the machine reachable?
- `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` — does the webhook URL match Fly's URL? Is there a `last_error_message`?
- If webhook is stale, redeploy or `fly secrets set WEBHOOK_URL=https://<app>.fly.dev` to retrigger `setWebhook`

**Out of memory**
- `fly logs` will show OOM kills. `fly scale memory 1024` to bump to 1 GB. ffmpeg is the usual culprit on voice/video messages.

**"app name taken" during `fly apps create`**
- Fly app names are globally unique. Pick something like `krapral-bot-<yourname>` and update `app = '...'` in `fly.toml`.

## Migrating off Google Cloud Run (one-time)

Once the Fly deploy is healthy and responding in Telegram:

1. Point Telegram at Fly (already covered by step 3 above — `setWebhook` runs on Fly startup).
2. Confirm no duplicate responses — old Cloud Run webhook should be overwritten by the Fly one.
3. Delete the Cloud Run service:
   ```bash
   gcloud run services delete krapral-bot --region europe-west1 --project vladomarenko
   ```
4. Delete unused images from Container Registry to stop storage charges:
   ```bash
   gcloud container images list-tags gcr.io/vladomarenko/krapral-bot
   gcloud container images delete gcr.io/vladomarenko/krapral-bot --force-delete-tags
   ```
5. Disable Cloud Build / Cloud Run / Container Registry APIs if nothing else in the project uses them (GCP console → APIs & Services).
6. Optional but recommended: check the billing dashboard after ~3 days to confirm spend has dropped.

Keep `GCP_STORAGE_BUCKET` around if you still want GCS log retention — that's ~cents/month.
