# Architecture: Krapral Telegram Bot

## Overview

Single-file TypeScript bot (`src/bot.ts`, ~620 lines) built on Telegraf + xAI Grok API. Embodies a fictional character "Krapral" in a Telegram group chat. OpenAI is used only for Whisper audio transcription.

## System Diagram

```
Telegram Users
      |
      v
 +-----------+     +-----------------+
 |  Telegraf  |---->| shouldKrapralSpeak() |
 | (polling/  |     | (reply decision)     |
 |  webhook)  |     +-----------------+
 +-----------+              |
      |                yes / no
      |                     |
      v                     v
 +------------------+   [silent]
 | getKrapralStream |
 | (Grok API)       |
 +------------------+
      |
      v
 +---------------------+
 | Post-processing     |
 | - cleanBotPrefix()  |
 | - isCensoredResponse() |
 | - isEmptyResponse() |
 | - [REACT:emoji]     |
 | - [POLL:Q|A|B]      |
 +---------------------+
      |
      v
 Telegram Chat
```

## File Structure

```
src/bot.ts              Main bot (single file)
identity.txt            Character system prompt (~190 lines)
users.json              User profiles: roles, triggers, relationships (8 members)
last_50.json            Auto-generated message history (last 50 messages)
grok_requests.log       API request/response log
.env                    Production environment (prod bot token)
.env.local              Development environment (dev bot token)
ecosystem.config.js     PM2 process manager config
Dockerfile              Multi-stage Docker build
cloudbuild.yaml         Google Cloud Build CI/CD
deploy*.sh              Deployment scripts
docs/                   Documentation (this folder)
```

## Core Components

### 1. Initialization (lines 1-110)

On startup, the bot:
1. Loads env vars via `dotenv/config`
2. Reads `identity.txt` and injects `users.json` content into the `<users.json>` placeholder
3. Initializes Grok client (xAI, OpenAI-compatible SDK) and OpenAI client (Whisper only)
4. Optionally connects to GCS bucket for log storage (skipped in dev mode)
5. Loads `users.json` into a `Set<string>` for known user lookups
6. Loads `last_50.json` history and marks all old message IDs as processed (spam protection)

### 2. Reply Decision: `shouldKrapralSpeak()` (lines 122-183)

Deterministic decision tree (no AI calls):

| Priority | Condition | Action |
|----------|-----------|--------|
| 0 | Private message (DM) | Always reply |
| 1 | Direct mention (7 trigger words) | Always reply |
| 2 | Unknown user (not in users.json) | Welcome them |
| 3 | Cooldown not passed (<5 messages since last reply) | Silent |
| 4 | Question detected in recent messages + cooldown passed | Reply |
| 5 | Long silence (10+ messages since last reply) | Reply |
| - | Default | Silent |

Trigger words: `капрал`, `крапрал`, `krapral`, `@krapral`, `краб`, `крабчик`, `крамар`

### 3. Response Generation: `getKrapralStream()` (lines 278-307)

- **Model**: `grok-4-1-fast-non-reasoning` (xAI, via OpenAI SDK compatibility)
- **Temperature**: 1.2 (high creativity)
- **Max tokens**: 2000
- **Streaming**: Enabled
- **Message format**: `[system prompt, ...history(50), user message]`
- Username `name` fields are sanitized to `[a-zA-Z0-9_-]` for API compatibility

### 4. Streaming Delivery (lines 342-377)

1. Send typing indicator
2. Send placeholder message `...`
3. Stream chunks from Grok, editing the placeholder every 1.5s or 50 chars
4. Final edit with complete response

### 5. Post-Processing (lines 398-480)

After streaming completes, responses go through:

| Step | Function | Purpose |
|------|----------|---------|
| 1 | `cleanBotPrefix()` | Strip `@Крапрал:` prefix the model sometimes adds |
| 2 | `isCensoredResponse()` | Detect refusal patterns (RU/EN), delete message if matched |
| 3 | `isEmptyResponse()` | Detect empty/dot-only responses, delete message if matched |
| 4 | `[REACT:emoji]` parser | Extract emoji, set as reaction on user's message |
| 5 | `[POLL:Q\|A\|B]` parser | Extract poll data, create Telegram poll |

On censorship/empty/error: the placeholder message is **deleted** (bot stays silent rather than breaking character).

### 6. Audio Transcription (lines 496-547)

- Handles: voice, audio, video, video_note
- Downloads file via Telegram API + axios
- Transcribes via OpenAI Whisper (`whisper-1`, language: `ru`)
- Passes transcribed text to `handleIncomingText()` (same pipeline as text)

### 7. HTTP Server (lines 549-618)

- Port: `PORT` env var or 8080
- `GET /` or `/health` - health check (JSON)
- `POST /webhook` - Telegram webhook endpoint
- **Production**: Sets webhook URL via Telegram API
- **Development**: Long polling with `dropPendingUpdates: true`
- Graceful shutdown on SIGINT/SIGTERM

## AI Models

| Model | Provider | Purpose |
|-------|----------|---------|
| `grok-4-1-fast-non-reasoning` | xAI (Grok) | Response generation |
| `whisper-1` | OpenAI | Audio/voice transcription |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | Yes | Bot token from BotFather |
| `GROK_API_KEY` | Yes | xAI API key |
| `OPENAI_API_KEY` | Yes | OpenAI key (Whisper only) |
| `BOT_MODE` | No | Set to `dev` for console-only logging |
| `NODE_ENV` | No | `production` for JSON logging |
| `GCP_STORAGE_BUCKET` | No | GCS bucket for log file storage |
| `USE_WEBHOOK` | No | `true` to force webhook mode |
| `WEBHOOK_URL` | No | Custom webhook URL |
| `PORT` | No | HTTP server port (default: 8080) |

## Dev Mode (`BOT_MODE=dev`)

- Uses dev bot token (via `.env.local`)
- Console-only logging (no file writes, no GCS)
- Same bot logic as production

```bash
npm run dev:mode    # dev token + dev mode
npm run dev:local   # dev token, normal logging
npm run dev         # prod token, normal logging
```

## Data Flow

```
User message
  -> processedMessageIds check (dedup)
  -> push to history[]
  -> saveHistory() -> last_50.json
  -> shouldKrapralSpeak()
     -> [silent] or [reply]
        -> getKrapralStream() -> Grok API (streaming)
        -> post-process (clean, censor check, react, poll)
        -> push response to history[]
        -> saveHistory()
        -> logRequest() -> grok_requests.log (or GCS)
```

## Key Design Decisions

1. **Grok-only responses** - chosen for less restrictive content policies, cheaper pricing ($0.20/$0.50 per 1M tokens), 2M context window
2. **No AI gatekeeper** - reply decisions are deterministic (no extra API calls), reducing latency and cost
3. **Streaming with edit** - sends `...` placeholder then edits in real-time for "typing" effect
4. **Silent on failure** - errors and censored responses are deleted rather than shown to users
5. **Single file** - entire bot logic in one file for simplicity
6. **users.json injection** - user profiles are injected into the system prompt at startup, giving the model full context about each member
