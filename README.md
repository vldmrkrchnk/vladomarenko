# Krapral Telegram Bot

Telegram bot that embodies "Krapral" - a fictional shell-shocked ex-VDV sergeant character for a friends' group chat.

## Features

- **Grok AI responses** via xAI API (`grok-4-1-fast-non-reasoning`) with streaming
- **Voice/audio transcription** via OpenAI Whisper
- **Smart reply gating** - deterministic rules for when to reply (direct mention, DM, cooldown, questions)
- **Emoji reactions** and **poll creation** via `[REACT:emoji]` / `[POLL:Q|A|B]` tags
- **Censorship filtering** - detects and silently suppresses AI refusals
- **Dev mode** - separate bot token with console-only logging
- **Production ready** - Docker, Fly.io, PM2, structured logging (pino)

## Quick Start

```bash
npm install
cp .env.example .env.local   # then fill in your dev bot token + API keys
npm run dev:mode             # dev bot token, console-only logging
```

See **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)** for the full local setup — creating your own test bot, API keys, conventions.

## Deploying

```bash
fly deploy
```

See **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** for the full deploy flow, rollback, and CI setup.

Legacy Google Cloud Run guide: [docs/DEPLOYMENT-GCLOUD.md](./docs/DEPLOYMENT-GCLOUD.md) (archive — the active host is Fly.io).

## Project Structure

```
src/bot.ts              Main bot implementation (~620 lines)
identity.txt            Character system prompt
users.json              User profiles (roles, triggers, relationships)
last_50.json            Message history (auto-generated, last 50)
.env                    Production env (not committed)
.env.local              Development env (not committed)
.env.example            Template — copy to .env.local and fill in
docs/                   Documentation
  DEVELOPMENT.md        Local dev setup + conventions
  DEPLOYMENT.md         Fly.io deploy flow
  ARCHITECTURE.md       Bot architecture and data flow
  DEPLOYMENT-GCLOUD.md  Archived legacy Google Cloud Run setup
ecosystem.config.js     PM2 config (VM deploys, unused)
Dockerfile              Docker build
fly.toml                Fly.io deploy config (active)
.github/workflows/      CI — auto-deploy on merge to main
cloudbuild.yaml         Cloud Build CI/CD (legacy GCP, unused)
```

## AI Models

| Model | Provider | Purpose |
|-------|----------|---------|
| `grok-4-1-fast-non-reasoning` | xAI | Response generation (streaming) |
| `whisper-1` | OpenAI | Audio/voice transcription |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | Yes | Bot token from BotFather |
| `GROK_API_KEY` | Yes | xAI API key |
| `OPENAI_API_KEY` | Yes | OpenAI key (Whisper only) |
| `BOT_MODE` | No | `dev` for console-only logging |
| `NODE_ENV` | No | `production` for JSON logging |
| `GCP_STORAGE_BUCKET` | No | GCS bucket for log storage |

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Dev with auto-reload (prod token) |
| `npm run dev:local` | Dev with dev bot token |
| `npm run dev:mode` | Dev mode (dev token + console-only logging) |
| `npm run build` | Compile TypeScript |
| `npm start` | Start production bot |

## Documentation

- [Development](./docs/DEVELOPMENT.md) - local setup, running the bot against your own test bot
- [Deployment](./docs/DEPLOYMENT.md) - Fly.io deploy flow, rollback, optional CI
- [Architecture](./docs/ARCHITECTURE.md) - how the bot works internally
- [Deployment (legacy GCP)](./docs/DEPLOYMENT-GCLOUD.md) - archived Google Cloud Run setup

## License

ISC
