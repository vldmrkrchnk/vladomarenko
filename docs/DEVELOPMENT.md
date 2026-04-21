# Local Development

This guide is for devs who want to run the bot on their own machine, talk to it via their own throwaway Telegram bot, and iterate on code without touching production.

## Prerequisites

- Node.js 20+ (`node -v`)
- npm (`npm -v`)
- A Telegram account
- `git` and a clone of this repo

## One-time setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your own test bot in Telegram

Each developer gets their own test bot — no sharing of tokens, no stepping on each other.

1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Pick a display name, e.g. `Krapral Dev (Alice)`
4. Pick a username ending in `bot`, e.g. `krapral_dev_alice_bot`
5. BotFather gives you a token — **this is your dev token**, keep it safe
6. While still in BotFather: `/setprivacy` → pick your bot → **Disable** (so the bot sees all messages in groups, not just @-mentions). This matches prod behaviour.

### 3. Get API keys

- **xAI Grok:** https://console.x.ai/ → API Keys → create one. Cheap per-request, no subscription.
- **OpenAI:** https://platform.openai.com/api-keys → create one. Used only for transcribing voice/video messages; you can leave it blank if you don't plan to test those.

**Never share or reuse the production keys.** Always make your own for dev.

### 4. Configure `.env.local`

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in:

```
TELEGRAM_TOKEN=<your dev bot token from BotFather>
GROK_API_KEY=<your xAI key>
OPENAI_API_KEY=<your OpenAI key, or leave blank>
BOT_MODE=dev
```

`.env.local` is gitignored. Don't commit it.

### 5. Start chatting with your dev bot

Open Telegram, search for the bot username you chose in step 2 (e.g. `@krapral_dev_alice_bot`), hit **Start**. In dev mode the bot responds to any chat (prod restricts to one group), so DMs work fine for quick testing.

## Daily workflow

### Run the bot locally

```bash
npm run dev:mode
```

What this does:
- Loads `.env.local` (your dev token, your API keys)
- Sets `BOT_MODE=dev` — console-only logging, no file/GCS writes
- Starts `ts-node-dev` with auto-reload on source changes

You'll see `pino-pretty` output in your terminal. Send a message to your dev bot on Telegram — logs appear, bot replies.

### Other scripts

| Script | When to use |
|---|---|
| `npm run dev:mode` | Default for local work — dev token, dev logging |
| `npm run dev:local` | Dev token but prod-style logging (testing logger output) |
| `npm run dev` | **Uses prod token from `.env`** — avoid unless you know why |
| `npm run build` | Typescript compile; run before `npm start` |
| `npm start` | Runs the built bot from `dist/` — what prod does |
| `npm run lint` | eslint |

### Common tasks

**Change the character prompt:** edit `identity.txt`. The bot reloads on restart. Test in your dev bot before committing.

**Change reply rules / handlers:** edit `src/bot.ts`. ts-node-dev auto-restarts on save.

**Add a new user to the roster:** edit `users.json`. Format is documented inline.

**Test voice transcription:** send a voice message to your dev bot. Requires `OPENAI_API_KEY` to be set.

**Stop the bot:** Ctrl-C in the terminal.

## Testing before you push

There's a scenario runner at `test-scenarios/`:

```bash
npm run build                                    # or use ts-node directly
node test-scenarios/run-tests.js                 # runs all scenarios
```

Scenarios are JSON files that simulate incoming messages and assert on the bot's decisions. Add a new scenario when you're testing a new rule or edge case. See `test-scenarios/README.md`.

## Conventions

- **Never hardcode your dev bot token or API keys in source.** They belong in `.env.local` only.
- **Don't run `npm run dev` against the prod bot** unless you're deliberately testing prod-path logic (webhook, GCS, production logger). You'll hijack the prod bot's updates.
- **Commit `.env.example` if you add a new required env var** — that's how the next dev knows what to set.
- **Never commit `.env`, `.env.local`, or any file with a real token.** `.gitignore` covers these already, but double-check before `git add`.

## Troubleshooting

**"TelegramError: 401 Unauthorized"**
Your `TELEGRAM_TOKEN` in `.env.local` is wrong, expired, or has a trailing newline/space. Re-copy from BotFather.

**"Cannot find module 'dotenv/config'"**
Run `npm install` again. You may be on a stale `node_modules`.

**"409 Conflict: terminated by other getUpdates request"**
Two processes are polling Telegram with the same token. Either your prod bot is on webhook-mode + you're running the same token locally, or you left a `npm run dev:mode` running in another terminal. Kill the duplicate.

**Bot doesn't reply in a group chat**
Make sure you disabled privacy mode in BotFather (step 2.6 above). Without that, the bot only sees messages that @-mention it or reply to it.

**Pretty logs look like JSON gibberish**
You've got `NODE_ENV=production` set. Unset it in `.env.local` for readable pino-pretty output locally.

## Deploying your changes to production

See [DEPLOYMENT.md → "Deploying a change"](./DEPLOYMENT.md#deploying-a-change-daily-flow).
