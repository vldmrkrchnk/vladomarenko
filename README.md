# Krapral Telegram Bot

Production-ready 24/7 Telegram bot that 100% embodies the character "Krapral" as defined in `identity.txt`.

## Features

- **Full Krapral Character**: Embodies the shell-shocked ex-VDV sergeant with mild army homoerotic brotherly love
- **Grok AI Brain**: Uses Grok API (grok-4 primary, grok-3 fallback) for intelligent responses
- **Persistent Memory**: Maintains last 50 messages with auto-save/load from `last_50.json`
- **@Username Format**: Strictly enforces @ symbol format for all users and bots (e.g., `@FedotovAndrii`, `@Krapral`)
- **Unknown Bot Handling**: Any bot/user not in `users.json` gets full Krapral treatment as "рядовой"
- **Production Ready**: Full logging (pino), retry logic for API errors, graceful shutdown

## Project Structure

```
├── src/
│   └── bot.ts              # Main bot implementation
├── identity.txt            # Full system prompt (biography, styles, rules)
├── users.json              # User database with roles and relationships
├── last_50.json           # Auto-created message history (last 50 messages)
├── .env                   # Environment variables (TELEGRAM_TOKEN, GROK_API_KEY)
├── tsconfig.json          # TypeScript configuration
├── package.json           # Dependencies and scripts
├── ecosystem.config.js    # PM2 configuration for production
└── README.md              # This file
```

## Prerequisites

- Node.js 18+ 
- npm or yarn
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Grok API Key (from [x.ai](https://x.ai))
- OpenAI API Key (from [OpenAI](https://platform.openai.com))

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
GROK_API_KEY=your_grok_api_key_here
OPENAI_API_KEY=your_openai_api_key_here

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

## Google Cloud Platform Integration

The bot supports Google Cloud Platform for production deployment.

### Features

- **Cloud Logging**: Application logs (pino) automatically sent to GCP Cloud Logging when `NODE_ENV=production` or `GCP_ENV=true`
- **Log Files**: Written to local files by default (works on Compute Engine VMs)
- **Cloud Storage** (optional): Only needed for serverless services (Cloud Run, App Engine, Functions)

### When Do You Need a Bucket?

**You DON'T need a bucket if:**
- Running on **Compute Engine** (VM) → Files are written to local disk (persistent if using persistent disk)
- Running locally → Files are written to project directory

**You DO need a bucket if:**
- Running on **Cloud Run** → Ephemeral filesystem, files are lost on restart
- Running on **App Engine** → Ephemeral filesystem
- Running on **Cloud Functions** → Ephemeral filesystem

### Setup

#### Option 1: Compute Engine (No Bucket Needed)

1. Deploy to a Compute Engine VM
2. Logs are written to local files: `grok_requests.log`, `openai_requests.log`
3. Access files via SSH or mount a persistent disk

#### Option 2: Cloud Run / App Engine (Bucket Required)

1. **Create a GCS Bucket**:
   ```bash
   gsutil mb gs://your-bucket-name
   ```

2. **Set up Authentication**:
   - Service account is automatically configured for Cloud Run/App Engine
   - For local testing: Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`

3. **Configure Environment Variables**:
   ```env
   GCP_STORAGE_BUCKET=your-bucket-name  # Required for Cloud Run/App Engine
   NODE_ENV=production                  # Enables JSON logging for Cloud Logging
   ```

4. **View Logs**:
   - **Application logs**: GCP Console → Logging → Logs Explorer
   - **Log files**: GCS Console → Your bucket → `logs/` folder
   - **Sync log files locally**:
     ```bash
     gsutil -m rsync -r gs://your-bucket-name/logs ./logs
     ```

### Log Files Location

- **Compute Engine / Local**: `grok_requests.log`, `openai_requests.log` (in project root)
- **Cloud Storage** (if configured): `gs://your-bucket-name/logs/grok_requests.log`, `gs://your-bucket-name/logs/openai_requests.log`

## How It Works

1. **Message Reception**: Bot receives text messages from any user or bot
2. **Username Formatting**: Every username is formatted with @ symbol (e.g., `@FedotovAndrii`)
3. **System Prompt**: Loads entire `identity.txt` as system prompt for Grok API
4. **Message History**: Attaches last 50 messages (including Krapral's replies) in OpenAI format with correct @names
5. **Step 1 - Grok API Call**: Sends request to Grok API (grok-4) to get initial response
6. **Step 2 - OpenAI Refinement**: Sends Grok's response + original context to OpenAI (gpt-4o) for validation and uniqueness
7. **Response**: Krapral responds with OpenAI's refined response (more unique and validated)
8. **History Update**: Saves user message and Krapral's response to `last_50.json`

### Two-Step AI Process

The bot uses a two-step AI process for better quality:
- **Grok API** (grok-4): Generates initial response based on character
- **OpenAI API** (gpt-4o): Validates and refines the response to make it more unique and ensure it matches Krapral's character perfectly

## Key Features Explained

### @Username Format (MANDATORY)

Every user and bot is identified with @ symbol:
- `@FedotovAndrii` ✅
- `@vinohradov` ✅
- `@babushkaTania_bot` ✅
- `FedotovAndrii` ❌ (missing @)
- User IDs ❌ (never used)

### Message Format for Grok API

Messages are sent in OpenAI format with `name` field:

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

### Unknown Bot/User Handling

Any bot or user NOT listed in `users.json`:
- Automatically gets rank "рядовой срочной службы"
- Receives full Krapral treatment (подколы, приказы, братская любовь)
- Addressed as `@theirusername` (e.g., "Рядовой @SomeRandomBot")

### Message History Format

Messages are stored in OpenAI format with name fields:

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

## Troubleshooting

### Bot not responding

1. Check logs: `pm2 logs krapral-bot` or check console output
2. Verify `.env` file has correct `TELEGRAM_TOKEN` and `GROK_API_KEY`
3. Check that `identity.txt` and `users.json` exist and are readable

### API Errors

- **429 (Rate Limit)**: Bot automatically retries with exponential backoff
- **500 (Server Error)**: Bot retries up to 3 times, then falls back to grok-3
- Check logs for detailed error messages

### History not persisting

- Ensure `last_50.json` file is writable
- Check file permissions in the project directory

## License

ISC

## Support

For issues or questions, check the logs first. The bot uses pino for structured logging with pretty-printed output in development.

