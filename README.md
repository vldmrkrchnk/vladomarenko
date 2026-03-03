# Krapral Telegram Bot

Production-ready 24/7 Telegram bot that 100% embodies the character "Krapral" as defined in `identity.txt`.

## Features

- **Full Krapral Character**: Embodies the shell-shocked ex-VDV sergeant with mild army homoerotic brotherly love
- **Dual AI Brain**: Grok (primary) for uncensored in-character responses, OpenAI GPT-5.2 (fallback)
- **Smart Reply Gating**: AI-powered context gatekeeper decides when to jump into conversation
- **Persistent Memory**: Maintains last 50 messages with auto-save/load from `last_50.json`
- **Rolling Chat Summary**: GPT-4o generates a 2-3 sentence vibe summary every 10 messages
- **Multimodal**: Voice/audio transcription (Whisper), video frame extraction (FFmpeg), photo handling
- **Poll Observer**: Monitors polls and drops roast comments when voting gets interesting
- **Emoji Reactions**: Can react to messages with emojis via `[REACTION:emoji]` tags
- **Internet Search**: DuckDuckGo integration for real-time information lookup
- **Message Debouncing**: 4-second batching to handle rapid-fire group messages
- **@Username Format**: Strictly enforces @ symbol format for all users and bots
- **Unknown User Handling**: Any user not in `users.json` gets full Krapral treatment as "рядовой"
- **Production Ready**: Structured logging (pino), graceful shutdown, Docker + Cloud Run support

## Project Structure

```
├── src/
│   └── bot.ts              # Main bot implementation (~700 lines)
├── dist/                    # Compiled JavaScript output
├── task/                    # Improvement task specs & analysis
│   ├── task.md             # Work packages specification
│   ├── bot_logic_map.md    # Architecture & optimization analysis
│   └── checklist.md        # Progress tracking
├── identity.txt            # Character system prompt (biography, styles, rules)
├── users.json              # User profiles database (roles, relationships, tone)
├── last_50.json            # Auto-created message history (last 50 messages)
├── .env                    # Environment variables
├── Dockerfile              # Multi-stage Docker build (node:20-slim)
├── cloudbuild.yaml         # Google Cloud Build CI/CD config
├── deploy*.sh              # Deployment scripts (Cloud Run, Cloud Build)
├── ecosystem.config.js     # PM2 configuration for production
├── tsconfig.json           # TypeScript configuration
├── package.json            # Dependencies and scripts
├── DEPLOYMENT.md           # Detailed GCP deployment guide
├── QUICK_START.md          # Quick deploy guide
└── README.md               # This file
```

## Prerequisites

- Node.js 18+
- npm or yarn
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- OpenAI API Key (from [OpenAI](https://platform.openai.com))
- Grok API Key (from [xAI](https://console.x.ai))

## Quick Deploy to Google Cloud

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment instructions.

**Quick start:**
```bash
./deploy.sh YOUR_PROJECT_ID
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create/update `.env` file:

```env
TELEGRAM_TOKEN=your_telegram_bot_token_here
OPENAI_API_KEY=your_openai_api_key_here
GROK_API_KEY=your_grok_api_key_here

# Optional: Google Cloud Platform integration
GCP_STORAGE_BUCKET=your-gcs-bucket-name  # For storing log files in Cloud Storage
NODE_ENV=production                       # Enables JSON logging for Cloud Logging
GCP_ENV=true                              # Alternative flag for GCP environment
```

### 3. Development Mode

Run with auto-reload on file changes:

```bash
npm run dev
```

### 4. Production Build

Build TypeScript to JavaScript:

```bash
npm run build
```

Start the bot:

```bash
npm start
```

## Production Deployment

### Option 1: PM2 (Recommended)

PM2 is a process manager for Node.js applications that keeps your bot running 24/7.

#### Install PM2 globally:

```bash
npm install -g pm2
```

#### Build and start:

```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow instructions to enable auto-start on reboot
```

#### PM2 Commands:

```bash
pm2 logs krapral-bot      # View logs
pm2 restart krapral-bot   # Restart bot
pm2 stop krapral-bot      # Stop bot
pm2 delete krapral-bot    # Remove from PM2
pm2 status                # Check status
```

### Option 2: systemd Service

Create `/etc/systemd/system/krapral-bot.service`:

```ini
[Unit]
Description=Krapral Telegram Bot
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/Vladomarenko
ExecStart=/usr/bin/node /path/to/Vladomarenko/dist/bot.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable krapral-bot
sudo systemctl start krapral-bot
sudo systemctl status krapral-bot
```

## How It Works

1. **Message Reception**: Bot receives messages (text, photo, voice, video) from users
2. **Debounce Buffer**: Messages are batched in a 4-second window to handle rapid messages
3. **Trigger Check**:
   - Direct mention (`@krapral`, `крапрал`, `капрал`, `краб`) or reply to bot → Reply immediately
   - Bot asked a question <2 minutes ago → Reply (conversational continuity)
   - Otherwise → AI gatekeeper (GPT-4o-mini) decides if Krapral should jump in
   - Fallback: 2% random chance during non-quiet hours (2am-7am excluded)
4. **Response Generation**: Grok (primary) or GPT-5.2 (fallback) generates in-character response with identity, user profiles, chat summary, and intent system
5. **Tool Use**: Bot can call internet search (DuckDuckGo) mid-response if needed
6. **Reaction Parsing**: `[REACTION:emoji]` tags are extracted and applied as message reactions
7. **History Update**: User message + bot response saved to `last_50.json`

### AI Models Used

| Model | Purpose | Frequency |
|-------|---------|-----------|
| **Grok grok-4-1-fast-non-reasoning** (primary) | Main response generation | Per reply |
| **GPT-5.2** (fallback) | Main response fallback | On Grok failure |
| **Grok grok-4-1-fast-non-reasoning** (primary) | Poll analysis & commentary | Once per poll (3+ votes) |
| **GPT-5.2** (fallback) | Poll analysis fallback | On Grok failure |
| **GPT-4o-mini** | Context gatekeeper ("should I reply?") | Per untagged message batch |
| **GPT-4o** | Rolling chat summary | Every 10 messages |
| **Whisper-1** | Audio/voice transcription | Per audio/video message |

### Media Processing

- **Voice/Audio**: Downloaded → Whisper transcription → processed as text
- **Video**: Downloaded → FFmpeg extracts 3 frames (10%, 50%, 90%) + audio transcription
- **Photos**: Caption extracted, image marked as placeholder

## Key Features Explained

### @Username Format (MANDATORY)

Every user and bot is identified with @ symbol:
- `@FedotovAndrii` ✅
- `@vinohradov` ✅
- `FedotovAndrii` ❌ (missing @)
- User IDs ❌ (never used)

### Message Format

Messages are sent in OpenAI chat format with `name` field:

```json
{
  "role": "user",
  "name": "@FedotovAndrii",
  "content": "Привет, Крапрал!"
}
```

```json
{
  "role": "assistant",
  "name": "@Krapral",
  "content": "Так точно, боец!"
}
```

### Intent System

Each response gets a random intent to vary behavior:
`tease`, `joke`, `react_short`, `react_deep`, `support_light`, `shift_topic`, `escalate_playfully`, `observe_silently`, `do_not_reply`

### Unknown User Handling

Any user NOT listed in `users.json`:
- Automatically gets rank "рядовой срочной службы"
- Receives full Krapral treatment (подколы, приказы, братская любовь)
- Addressed as `@theirusername`

## Troubleshooting

### Bot not responding

1. Check logs: `pm2 logs krapral-bot` or check console output
2. Verify `.env` file has correct `TELEGRAM_TOKEN` and `OPENAI_API_KEY`
3. Check that `identity.txt` and `users.json` exist and are readable

### API Errors

- Check logs for detailed error messages
- OpenAI errors are caught and logged via pino

### History not persisting

- Ensure `last_50.json` file is writable
- Check file permissions in the project directory

## License

ISC
