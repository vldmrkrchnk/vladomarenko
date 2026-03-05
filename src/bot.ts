// bot.ts — Крапрал 3.0: умный, спокойный, непобедимый
import { Telegraf } from 'telegraf';
import fs from 'fs';
import axios from 'axios';
import pino from 'pino';
import OpenAI from 'openai';
import { toFile } from 'openai';
import http from 'http';
import 'dotenv/config';

// Logger: pretty-printed for local dev, JSON for GCP production
const logger = pino({
	level: 'info',
	...(process.env.NODE_ENV === 'production' || process.env.GCP_ENV === 'true'
		? {} // JSON output for GCP (stdout → Cloud Logging)
		: { transport: { target: 'pino-pretty' } } // Pretty for local dev
	)
});

const TOKEN = process.env.TELEGRAM_TOKEN!;
const GROK_KEY = process.env.GROK_API_KEY!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
// Load identity and inject users.json into the placeholder
const RAW_IDENTITY = fs.readFileSync('identity.txt', 'utf-8');
const USERS_JSON_CONTENT = fs.existsSync('users.json') ? fs.readFileSync('users.json', 'utf-8') : '{}';
const IDENTITY = RAW_IDENTITY.replace(
	/\[ВСТАВЬ СЮДА ВЕСЬ ТВОЙ JSON ИЗ ПЕРВОГО СООБЩЕНИЯ\]/,
	USERS_JSON_CONTENT
);

// Dev mode: console logging only, no file/GCS writes
const DEV_MODE = process.env.BOT_MODE === 'dev';

// Only respond in this group (and DMs). In dev mode, allow any chat for testing.
const ALLOWED_CHAT_ID = -1001826428556;

// Grok model for responses
const GROK_MODEL = 'grok-4-1-fast-non-reasoning';

// Initialize OpenAI client (used only for Whisper transcription)
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Initialize Grok client (primary response model)
const grok = new OpenAI({
	apiKey: GROK_KEY,
	baseURL: 'https://api.x.ai/v1'
});

// GCP Cloud Storage for log files (OPTIONAL - only needed for serverless services)
let gcsBucket: any = null;
if (DEV_MODE) {
	logger.info('[DEV MODE] File/GCS logging disabled — console only');
} else if (process.env.GCP_STORAGE_BUCKET) {
	try {
		const { Storage } = require('@google-cloud/storage');
		const storage = new Storage();
		gcsBucket = storage.bucket(process.env.GCP_STORAGE_BUCKET);
		logger.info(`GCP Cloud Storage enabled for log files: ${process.env.GCP_STORAGE_BUCKET}`);
	} catch (e) {
		logger.warn({ error: e }, 'GCP Storage not available, using local files');
	}
} else {
	logger.info('Using local file storage for logs (works on Compute Engine, Cloud Run needs GCP_STORAGE_BUCKET)');
}

// Interfaces
interface Msg {
	role: 'user' | 'assistant';
	name: string;
	content: string;
	timestamp: number;
	message_id?: number;
	chat_id?: number;
}

// Global State
let history: Msg[] = [];
const HISTORY_FILE = 'last_50.json';
const LOGS_FILE = 'grok_requests.log';
const MIN_MESSAGES_BETWEEN_RESPONSES = 5;
const USERS_FILE = 'users.json';

// Load known users
let knownUsers = new Set<string>();
if (fs.existsSync(USERS_FILE)) {
	try {
		const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
		if (usersData.participants) {
			knownUsers = new Set(Object.keys(usersData.participants));
			logger.info(`Loaded ${knownUsers.size} known users from users.json`);
		}
	} catch (e) {
		logger.error({ error: e }, 'Error loading users.json');
	}
}

// Map usernames to display names (pre-seeded with known squad + learned from Telegram)
const displayNames: Record<string, string> = {
	'@FedotovAndrii': 'Капрон',
	'@vinohradov': 'Андрій',
	'@nehoroshevVl': 'Вован',
	'@Ihorushka': 'Ігор',
	'@ynddw': 'Пузань',
	'@vinograd1ka': 'Виноградик',
	'@olejatir': 'Олежатір',
	'@Waltons777': 'Олег',
};

function updateDisplayName(user: any) {
	if (user.username && user.first_name) {
		displayNames[`@${user.username}`] = user.first_name;
	}
}

function getDisplayLabel(username: string): string {
	const displayName = displayNames[username];
	if (displayName) return `[${displayName} (${username})]`;
	return `[${username}]`;
}

// === MAIN PROTECTION FROM SPAM ON STARTUP ===
const processedMessageIds = new Set<number>();

// Load history + mark all old messages as processed
if (fs.existsSync(HISTORY_FILE)) {
	try {
		const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
		history = Array.isArray(raw) ? raw.slice(-50) : [];
		history.forEach(msg => {
			if (msg.message_id) processedMessageIds.add(msg.message_id);
		});
		logger.info(`Loaded ${history.length} messages from history → old ones marked as processed`);
	} catch (e) {
		logger.error({ error: e }, 'Error loading history');
		history = [];
	}
}

function saveHistory() {
	fs.promises.writeFile(HISTORY_FILE, JSON.stringify(history.slice(-50), null, 2))
		.catch(err => logger.error({ error: err }, 'Failed to save history'));
}

function formatName(user: any): string {
	if (user.username) return `@${user.username}`;
	return `@${(user.first_name || 'Аноним').replace(/\s/g, '_')}`;
}

// Should Krapral speak?
function shouldKrapralSpeak(username: string, text: string, chatType: string, chatId?: number): boolean {
	const lower = text.toLowerCase();
	logger.info(`[shouldKrapralSpeak] Checking "${text}" (lower: "${lower}") from ${username} in ${chatType} (chatId: ${chatId})`);

	// 0. Private messages — ALWAYS reply
	if (chatType === 'private') {
		logger.info(`[DM] ${username} writes in DM → replying`);
		return true;
	}

	// 1. Direct ping — ALWAYS reply
	const KRAPRAL_TRIGGERS = ["капрал", 'крапрал', 'krapral', '@krapral', 'краб', "крабчик", "крамар"];
	if (KRAPRAL_TRIGGERS.some(trigger => lower.includes(trigger))) {
		logger.info(`[DIRECT PING] ${username} mentioned Krapral → replying`);
		return true;
	}

	// 2. New soldier (not in users.json) — welcome them
	if (!knownUsers.has(username)) {
		logger.info(`[NEW SOLDIER] ${username} → welcoming`);
		return true;
	}

	// 3. Cooldown check: how many messages since last Krapral response IN THIS CHAT?
	const relevantHistory = chatId
		? history.filter(m => m.chat_id === chatId || m.chat_id === undefined)
		: history;

	const lastKrapralResponse = relevantHistory.slice().reverse().find(m => m.role === 'assistant');
	if (!lastKrapralResponse) {
		return false;
	}

	const messagesSinceLastResponse = relevantHistory.filter(
		m => m.timestamp > lastKrapralResponse.timestamp && m.role === 'user'
	).length;

	if (messagesSinceLastResponse < MIN_MESSAGES_BETWEEN_RESPONSES) {
		logger.debug(`[COOLDOWN] Only ${messagesSinceLastResponse} messages in chat ${chatId}, need at least ${MIN_MESSAGES_BETWEEN_RESPONSES}`);
		return false;
	}

	// 4. Check if recent messages contain a question
	const recentMessages = relevantHistory.slice(-10).filter(m => m.role === 'user');
	const hasQuestion = recentMessages.some(m =>
		/\?/.test(m.content) ||
		/\b(что|как|когда|где|почему|кто)\b/i.test(m.content)
	);

	// Skip short emotional outbursts not directed at the bot (rules 4 & 5)
	const words = text.trim().split(/\s+/);
	const isBriefOutburst = words.length < 5 && !lower.includes('?');
	if (isBriefOutburst) {
		logger.debug(`[SKIP] Short message without question from ${username}, not engaging`);
		return false;
	}

	if (hasQuestion && messagesSinceLastResponse >= MIN_MESSAGES_BETWEEN_RESPONSES) {
		logger.info(`[QUESTION] ${username} asked a question, ${messagesSinceLastResponse} messages passed → replying`);
		return true;
	}

	// 5. Long silence (10+ messages) — can chime in
	if (messagesSinceLastResponse >= 10) {
		logger.info(`[LONG SILENCE] ${messagesSinceLastResponse} messages passed → can reply`);
		return true;
	}

	return false;
}


// Log file writer (local or GCS) — skipped in dev mode
async function appendToLogFile(filename: string, content: string) {
	if (DEV_MODE) return;
	if (gcsBucket) {
		try {
			// Write each entry as a separate file to avoid download+append+re-upload
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const base = filename.replace(/\.[^.]+$/, '');
			const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '.log';
			const entryFile = gcsBucket.file(`logs/${base}/${timestamp}${ext}`);
			await entryFile.save(content, {
				metadata: { contentType: 'text/plain' }
			});
		} catch (error) {
			logger.error({ error }, `Failed to write ${filename} to GCS, falling back to local`);
			fs.appendFileSync(filename, content, 'utf-8');
		}
	} else {
		fs.appendFileSync(filename, content, 'utf-8');
	}
}

// Log request and response
async function logRequest(apiName: string, messages: any[], response: string, username: string, model: string) {
	try {
		const timestamp = new Date().toISOString();
		const identity = IDENTITY.substring(0, 30) + (IDENTITY.length > 30 ? '...' : '');
		const messagesPreview = messages
			.filter((m: any) => m.role !== 'system')
			.map((m: any) => {
				const name = m.name ? `${m.name}: ` : '';
				const content = m.content.length > 100
					? m.content.substring(0, 100) + '...'
					: m.content;
				return `  [${m.role}] ${name}${content}`;
			})
			.join('\n');

		const logEntry = `
================================================================================
[${timestamp}] ${apiName} Request from @${username}
Model: ${model}
Identity (first 30 chars): ${identity}

Messages sent:
${messagesPreview}

Response:
${response}

================================================================================
`;
		const logFile = LOGS_FILE;
		await appendToLogFile(logFile, logEntry);
	} catch (error) {
		logger.error({ error }, `Failed to log ${apiName} request`);
	}
}

// Detect censorship / broken responses that should be retried or suppressed
const CENSORSHIP_PATTERNS = [
	/^извини(те)?,?\s*(я\s+)?не\s+могу/i,
	/^i'?m\s+sorry,?\s*i\s+can'?t/i,
	/^sorry,?\s*i\s+can'?t/i,
	/^i\s+can'?t\s+assist/i,
	/^я\s+не\s+могу\s+помочь/i,
	/^к сожалению,?\s*(я\s+)?не\s+могу/i,
	/^as an ai/i,
	/^как (ии|искусственный интеллект)/i,
];

function isCensoredResponse(text: string): boolean {
	const trimmed = text.trim();
	return CENSORSHIP_PATTERNS.some(p => p.test(trimmed));
}

function isEmptyResponse(text: string): boolean {
	const trimmed = text.trim();
	return !trimmed || /^\.{1,3}(\s*\(.*\))?$/.test(trimmed);
}

// Strip "@Krapral:" prefix that the model sometimes adds (Cyrillic + Latin variants)
function cleanBotPrefix(text: string): string {
	return text
		.replace(/^(@?[Кк]р[аa]пр[аa]л[:\s]*)+/i, '')
		.replace(/^@?[Kk]rapral[_]?(?:bot)?[:\s]*/i, '')
		.trim();
}

// === WEB SEARCH & URL FETCHING ===

// Detect if message needs live web context
const NEWS_KEYWORDS = /(новост|что происход|что случил|войн[аеуыоёй]|конфликт|обстрел|удар[аеи]|бомб|санкци|переговор|атак[аеуио]|наступлен|операци|фронт|ситуаци[яи]|что там с|что нового|последн|свеж|сегодня|сейчас|обстановк)/i;
const URL_PATTERN = /https?:\/\/[^\s<>\"']+/gi;

function needsWebSearch(text: string): boolean {
	return NEWS_KEYWORDS.test(text);
}

function extractUrls(text: string): string[] {
	return text.match(URL_PATTERN) || [];
}

// Search the web using DuckDuckGo (no API key required)
async function webSearch(query: string): Promise<string> {
	try {
		const resp = await axios.get('https://html.duckduckgo.com/html/', {
			params: { q: query, kl: 'ru-ru' },
			headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
			timeout: 5000
		});
		const matches = resp.data.match(/<a class="result__snippet"[^>]*>(.*?)<\/a>/gs);
		if (!matches || matches.length === 0) return '(no results found)';
		const results = matches.slice(0, 5).map((m: string, i: number) => {
			const text = m.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
			return `${i + 1}. ${text}`;
		});
		return results.join('\n');
	} catch (err: any) {
		logger.warn({ error: err.message }, 'Web search failed');
		return '(search failed)';
	}
}

// Fetch URL content and extract readable text
async function fetchUrlContent(url: string): Promise<string> {
	try {
		const resp = await axios.get(url, {
			timeout: 5000,
			maxRedirects: 3,
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KrapralBot/1.0)' },
			responseType: 'text'
		});
		const html = typeof resp.data === 'string' ? resp.data : '';
		// Extract page title
		const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
		const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
		// Extract meta description
		const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["'][^>]*>/i)
			|| html.match(/<meta[^>]*content=["'](.*?)["'][^>]*name=["']description["'][^>]*>/i);
		const metaDesc = metaMatch ? metaMatch[1].trim() : '';
		// Extract og:description
		const ogMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["'](.*?)["'][^>]*>/i)
			|| html.match(/<meta[^>]*content=["'](.*?)["'][^>]*property=["']og:description["'][^>]*>/i);
		const ogDesc = ogMatch ? ogMatch[1].trim() : '';
		// Extract article/main text (strip scripts, styles, tags)
		const bodyMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i)
			|| html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
		const bodyHtml = bodyMatch ? bodyMatch[1] : html;
		const bodyText = bodyHtml
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
			.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
			.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
			.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.substring(0, 1500);

		const parts = [];
		if (title) parts.push(`Title: ${title}`);
		if (metaDesc || ogDesc) parts.push(`Description: ${metaDesc || ogDesc}`);
		if (bodyText) parts.push(`Content: ${bodyText}`);
		return parts.join('\n') || '(could not extract content)';
	} catch (err: any) {
		logger.warn({ error: err.message, url }, 'URL fetch failed');
		return `(failed to load: ${err.message})`;
	}
}

// Build extra context from web search and URLs
async function getWebContext(text: string): Promise<string | null> {
	const urls = extractUrls(text);
	const shouldSearch = needsWebSearch(text);

	if (!shouldSearch && urls.length === 0) return null;

	const parts: string[] = [];

	// Fetch URL content in parallel
	if (urls.length > 0) {
		const urlResults = await Promise.all(urls.slice(0, 3).map(async (url) => {
			const content = await fetchUrlContent(url);
			return `[Content from ${url}]:\n${content}`;
		}));
		parts.push(...urlResults);
	}

	// Web search if needed
	if (shouldSearch) {
		const searchQuery = text
			.replace(URL_PATTERN, '')
			.replace(/^[@]?(капрал|крапрал|krapral|краб|крабчик|крамар)[,;:!.\s]*/gi, '')
			.trim();
		if (searchQuery.length > 3) {
			const results = await webSearch(searchQuery);
			parts.push(`[Web search results for "${searchQuery}"]:\n${results}`);
		}
	}

	if (parts.length === 0) return null;
	return parts.join('\n\n');
}

// Strip trigger words from user messages before sending to the model.
// Users prefix messages with "крапрал" to address the bot — the model doesn't need to see this,
// and repeated trigger words across messages can make Grok think the user is "repeating themselves".
const TRIGGER_STRIP_PATTERN = /^[@]?(капрал|крапрал|krapral|краб|крабчик|крамар)[,;:!.\s]*/gi;
function stripTriggerWords(text: string): string {
	return text.replace(TRIGGER_STRIP_PATTERN, '').trim() || text;
}

// Grok streaming response
async function getKrapralStream(text: string, username: string, webContext?: string | null) {
	const userContent = `${getDisplayLabel(username)}: ${stripTriggerWords(text)}`;
	// If we have web context, append it to the user message so Grok can reference it
	const enrichedContent = webContext
		? `${userContent}\n\n--- АКТУАЛЬНАЯ ИНФОРМАЦИЯ ИЗ ИНТЕРНЕТА (используй для ответа, но отвечай в своём стиле) ---\n${webContext}`
		: userContent;

	const messages = [
		{ role: 'system' as const, content: IDENTITY },
		...history.map(m => ({
			role: m.role as 'user' | 'assistant',
			name: m.name,
			content: m.role === 'user'
				? `${getDisplayLabel(m.name)}: ${stripTriggerWords(m.content)}`
				: m.content
		})),
		{ role: 'user' as const, name: username, content: enrichedContent }
	];

	const typedMessages = messages.map(m => ({
		role: m.role,
		name: ('name' in m && m.name) ? m.name.replace(/[^a-zA-Z0-9_-]/g, '_') : undefined,
		content: m.content
	}));

	logger.info(`Using Grok API (model: ${GROK_MODEL})`);

	try {
		const stream = await grok.chat.completions.create({
			model: GROK_MODEL,
			messages: typedMessages as any,
			temperature: 1.2,
			max_tokens: 2000,
			stream: true
		});
		return { stream, api: 'grok', model: GROK_MODEL };
	} catch (err: any) {
		logger.error({ error: { message: err.message, status: err.status, type: err.type } }, 'Grok API error');
		throw err;
	}
}

// Context-aware reaction picker
const REACTION_CATEGORIES: { pattern: RegExp; emojis: string[] }[] = [
	{ pattern: /ахах|хах|лол|ржу|смех|😂|🤣|ору|кек|рофл/i, emojis: ['😂', '🤣', '💯', '😁', '🤡', '🥴'] },
	{ pattern: /круто|огонь|пиздат|заеб|дерзк|топ|красав|мощ|жест|сильн|база/i, emojis: ['🔥', '💯', '🏆', '⚡', '👏', '🤩'] },
	{ pattern: /люб|серд|брат|обним|спасиб|❤|молодец|горж/i, emojis: ['❤️', '❤️‍🔥', '🥰', '😍', '🤗', '💘'] },
	{ pattern: /так точн|есть|доклад|слава|приказ|крапрал|капрал|отставить|строй|рядов/i, emojis: ['🫡', '👍', '👌', '🎖', '✍️'] },
	{ pattern: /бля|хуй|пизд|ебат|что блять|охуе|нихуя|ёб|жесть|ппц|пиз/i, emojis: ['🤯', '😱', '🤬', '💀', '🗿', '😈'] },
	{ pattern: /грус|печал|тоск|плох|хуёв|дерьм|устал|заеб/i, emojis: ['😢', '😭', '💔', '🙏'] },
	{ pattern: /стикер|фото|видео|мем|картинк/i, emojis: ['👀', '🌚', '👾', '🤓'] },
	{ pattern: /пить|пив|водк|вин|бухать|налив|виски|шот/i, emojis: ['🍾', '🍌', '🌭', '🥴'] },
	{ pattern: /нарк|трав|дунуть|курн|солей|спид|марк/i, emojis: ['💊', '🌚', '😈', '🤪'] },
];

function pickContextReaction(text: string): string | null {
	const lower = text.toLowerCase();
	const matched = REACTION_CATEGORIES.filter(cat => cat.pattern.test(lower));
	if (matched.length === 0) return null;
	const category = matched[Math.floor(Math.random() * matched.length)];
	return category.emojis[Math.floor(Math.random() * category.emojis.length)];
}

// === BOT SETUP ===
const bot = new Telegraf(TOKEN);
bot.start(ctx => ctx.reply('Крапрал на посту. Пятая точка в строю.'));

// Handle incoming text (used for both text and transcribed messages)
async function handleIncomingText(ctx: any, text: string, username: string, messageId: number, chatType: string = 'private') {
	if (processedMessageIds.has(messageId)) {
		return;
	}
	processedMessageIds.add(messageId);

	// Prune processedMessageIds to prevent memory leak — keep last 1000
	if (processedMessageIds.size > 1000) {
		const ids = Array.from(processedMessageIds);
		const toDelete = ids.slice(0, ids.length - 1000);
		for (const id of toDelete) processedMessageIds.delete(id);
	}

	const chatId = ctx.chat?.id;

	// Restrict to allowed group + DMs (skip in dev mode for testing)
	if (!DEV_MODE && chatType !== 'private' && chatId !== ALLOWED_CHAT_ID) {
		logger.debug(`[IGNORED] Message from unauthorized chat ${chatId}`);
		return;
	}

	history.push({
		role: 'user',
		name: username,
		content: text,
		timestamp: Date.now(),
		message_id: messageId,
		chat_id: chatId
	});
	saveHistory();

	const shouldSpeak = shouldKrapralSpeak(username, text, chatType, chatId);
	if (!shouldSpeak) {
		logger.info(`[SILENT] Krapral not replying to "${text}" from ${username}`);

		// 15% chance to put a context-aware silent reaction when not replying
		if (chatType !== 'private' && Math.random() < 0.15) {
			const emoji = pickContextReaction(text);
			if (emoji) {
				try {
					await ctx.telegram.setMessageReaction(ctx.chat.id, messageId, [{ type: 'emoji', emoji }]);
					logger.info(`[SILENT REACTION] ${emoji} on message ${messageId} from ${username}`);
				} catch (e: any) {
					logger.warn({ error: e.message }, `Failed to set silent reaction ${emoji}`);
				}
			}
		}

		return;
	}

	logger.info(`[REPLY] Krapral decided to reply to "${text}" from ${username}`);
	let sentMessageInfo: any = null;
	let fullResponse = '';

	try {
		await ctx.sendChatAction('typing');

		// Fetch web context if message contains URLs or asks about current events
		const webContext = await getWebContext(text);
		if (webContext) {
			logger.info(`[WEB CONTEXT] Fetched ${webContext.length} chars of web context for "${text.substring(0, 50)}"`);
		}

		const result = await getKrapralStream(text, username, webContext);
		const { stream, model } = result;
		logger.info(`Krapral replying to ${username} | Grok (${model})`);

		// Send placeholder message linked to the user's message
		sentMessageInfo = await ctx.reply('...', { reply_to_message_id: messageId });

		let lastEditTime = Date.now();
		let buffer = '';

		for await (const chunk of stream) {
			const content = chunk.choices[0]?.delta?.content || '';
			if (content) {
				fullResponse += content;
				buffer += content;
				const now = Date.now();

				if (now - lastEditTime > 1500 || buffer.length > 50) {
					try {
						const displayText = cleanBotPrefix(fullResponse) || '...';
						await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, displayText);
						lastEditTime = now;
						buffer = '';
					} catch (ignore) { }
				}
			}
		}

		// Final update with cleaned text
		if (fullResponse && buffer.length > 0) {
			try {
				const displayText = cleanBotPrefix(fullResponse) || '...';
				await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, displayText);
			} catch (ignore) { }
		}

		// Log response to Cloud Logging for debugging
		logger.info(`[RESPONSE] to ${username}: "${fullResponse.substring(0, 200)}"`);

		// Log full request
		const originalMessages = [
			{ role: 'system', content: IDENTITY },
			...history.map(m => ({ role: m.role, name: m.name, content: m.content })),
			{ role: 'user', name: username, content: text }
		];
		await logRequest('Grok', originalMessages, fullResponse, username, model);
	} catch (error) {
		logger.error({ error }, 'Error during streaming response');
		// Delete the placeholder message on error — stay silent instead of sending error text
		if (sentMessageInfo) {
			try {
				await ctx.telegram.deleteMessage(ctx.chat.id, sentMessageInfo.message_id);
			} catch (ignore) { }
		}
		logger.warn('[ERROR] API failed, staying silent instead of sending error message');
		return;
	}

	// Clean up response: strip bot name prefix
	fullResponse = cleanBotPrefix(fullResponse);

	// Handle censored responses: delete message and stay silent
	if (isCensoredResponse(fullResponse) || isEmptyResponse(fullResponse)) {
		logger.warn(`[CENSORED/EMPTY] Suppressing response: "${fullResponse.substring(0, 100)}"`);
		if (sentMessageInfo) {
			try {
				await ctx.telegram.deleteMessage(ctx.chat.id, sentMessageInfo.message_id);
			} catch (ignore) { }
		}
		return;
	}

	// Update the message with cleaned response
	if (sentMessageInfo) {
		try {
			await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, fullResponse);
		} catch (ignore) { }
	}

	let responseText = fullResponse;
	let actionDescription = '';

	// 1. Handle reactions: [REACT:emoji]
	const reactMatch = responseText.match(/\[REACT:(.+?)\]/);
	if (reactMatch) {
		const emoji = reactMatch[1].trim();
		responseText = responseText.replace(reactMatch[0], '').trim();

		if (responseText && sentMessageInfo) {
			// Text + reaction: update the message with the text part
			try {
				await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, responseText);
			} catch (e) { }
		} else if (!responseText && sentMessageInfo) {
			// Reaction-only: delete the placeholder message
			try {
				await ctx.telegram.deleteMessage(ctx.chat.id, sentMessageInfo.message_id);
			} catch (e) { }
		}

		try {
			await ctx.telegram.setMessageReaction(ctx.chat.id, messageId, [{ type: 'emoji', emoji }]);
			logger.info(`[REACTION] Set reaction ${emoji} to message ${messageId}`);
			if (!responseText) actionDescription = `(Reaction: ${emoji})`;
		} catch (e: any) {
			logger.warn({ error: e.message }, `Failed to set reaction ${emoji}`);
		}
	}

	// 2. Handle polls: [POLL:Question|Option1|Option2]
	const pollMatch = responseText.match(/\[POLL:(.+?)\]/);
	if (pollMatch) {
		const pollContent = pollMatch[1];
		responseText = responseText.replace(pollMatch[0], '').trim();

		if (sentMessageInfo) {
			try {
				await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, responseText || '...');
			} catch (e) { }
		}

		const parts = pollContent.split('|').map(p => p.trim()).filter(p => p);
		if (parts.length >= 3) {
			const question = parts[0];
			const options = parts.slice(1);
			try {
				await ctx.replyWithPoll(question, options, { is_anonymous: false });
				logger.info(`[POLL] Created poll: ${question}`);
				if (!responseText && !actionDescription) actionDescription = `(Created poll: ${question})`;
				else if (actionDescription) actionDescription += `, (Created poll: ${question})`;
			} catch (e: any) {
				logger.error({ error: e.message }, `Failed to create poll`);
				responseText += `\n(Не смог создать опрос, командир...)`;
			}
		}
	}

	// Save to history
	const historyContent = responseText || actionDescription || '(Action performed)';
	history.push({
		role: 'assistant',
		name: '@Krapral',
		content: historyContent,
		timestamp: Date.now(),
		chat_id: ctx.chat?.id
	});
	saveHistory();
}

// Text handler
bot.on('text', async (ctx) => {
	const msg = ctx.message;
	if (!msg || !msg.text) return;
	// Ignore own messages (prevent self-reply loops)
	if (msg.from?.is_bot && msg.from?.id === bot.botInfo?.id) return;
	const messageId = msg.message_id;
	updateDisplayName(msg.from);
	const username = formatName(msg.from);
	let text = msg.text.trim();
	const chatType = ctx.chat.type;

	// Include reply-to context so the model knows what the user is responding to
	const replyMsg = (msg as any).reply_to_message;
	if (replyMsg?.text) {
		const replyAuthor = replyMsg.from ? formatName(replyMsg.from) : 'unknown';
		text = `[Replying to ${replyAuthor}: "${replyMsg.text}"] ${text}`;
	}

	await handleIncomingText(ctx, text, username, messageId, chatType);
});

// Audio/voice/video transcription handler
async function handleAudioTranscription(ctx: any) {
	const msg = ctx.message;
	if (!msg) return;
	const messageId = msg.message_id;
	updateDisplayName(ctx.from);
	const username = formatName(ctx.from);
	const chatType = ctx.chat.type;

	if (processedMessageIds.has(messageId)) {
		return;
	}

	try {
		let fileId: string;
		if (msg.voice) fileId = msg.voice.file_id;
		else if (msg.audio) fileId = msg.audio.file_id;
		else if (msg.video) fileId = msg.video.file_id;
		else if (msg.video_note) fileId = msg.video_note.file_id;
		else return;

		const fileLink = await ctx.telegram.getFileLink(fileId);

		const response = await axios.get(fileLink.toString(), { responseType: 'stream' });
		const chunks: Buffer[] = [];
		for await (const chunk of response.data) {
			chunks.push(Buffer.from(chunk));
		}
		const audioBuffer = Buffer.concat(chunks);
		const audioFile = await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' });

		const transcript = await openai.audio.transcriptions.create({
			model: 'whisper-1',
			file: audioFile,
			language: 'ru'
		});

		const transcribedText = transcript.text.trim();
		if (!transcribedText) return;

		logger.info(`Audio transcribed for ${username}: "${transcribedText}"`);
		await handleIncomingText(ctx, transcribedText, username, messageId, chatType);
	} catch (error: any) {
		logger.error({
			error: error?.message || error,
			stack: error?.stack,
			username,
			messageId
		}, 'Error processing audio/video transcription');
	}
}

bot.on(['voice', 'audio', 'video', 'video_note'], handleAudioTranscription);

// Sticker handler — extract emoji and pass to handleIncomingText
bot.on('sticker', async (ctx) => {
	const msg = ctx.message;
	if (!msg?.sticker) return;
	if (msg.from?.is_bot && msg.from?.id === bot.botInfo?.id) return;
	const emoji = msg.sticker.emoji || '?';
	const messageId = msg.message_id;
	updateDisplayName(msg.from);
	const username = formatName(msg.from);
	const chatType = ctx.chat.type;
	await handleIncomingText(ctx, `[STICKER: ${emoji}]`, username, messageId, chatType);
});

// HTTP Server for Cloud Run
const PORT = process.env.PORT || 8080;
const server = http.createServer(async (req, res) => {
	if (req.url === '/health' || req.url === '/') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', service: 'krapral-bot' }));
		return;
	}
	if (req.url === '/webhook' && req.method === 'POST') {
		let body = '';
		req.on('data', (chunk: any) => { body += chunk.toString(); });
		req.on('end', async () => {
			try {
				await bot.handleUpdate(JSON.parse(body));
				res.writeHead(200, { 'Content-Type': 'text/plain' });
				res.end('OK');
			} catch (err) {
				logger.error({ error: err }, 'Webhook error');
				res.writeHead(500, { 'Content-Type': 'text/plain' });
				res.end('Error');
			}
		});
		return;
	}
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not Found');
});

server.listen(PORT, async () => {
	logger.info(`HTTP server listening on port ${PORT}`);

	if (process.env.NODE_ENV === 'production' || process.env.USE_WEBHOOK === 'true') {
		const webhookUrl = process.env.WEBHOOK_URL || process.env.K_SERVICE_URL
			? `${process.env.WEBHOOK_URL || process.env.K_SERVICE_URL}/webhook`
			: null;
		if (webhookUrl) {
			try {
				await bot.telegram.setWebhook(webhookUrl);
				logger.info(`Webhook set to: ${webhookUrl}`);
				logger.info('Krapral 3.0 on duty (Webhook mode)');
			} catch (err) {
				logger.error({ error: err }, 'Failed to set webhook, falling back to polling');
				bot.launch({ dropPendingUpdates: true });
			}
		} else {
			logger.warn('WEBHOOK_URL not set, using polling mode');
			bot.launch({ dropPendingUpdates: true });
		}
	} else {
		bot.launch({ dropPendingUpdates: true });
		logger.info('Krapral 3.0 on duty (Polling mode)');
	}

	if (DEV_MODE) {
		logger.info('========================================');
		logger.info('  DEV MODE — console logging only');
		logger.info('========================================');
	}

	logger.info(`MODEL: ${GROK_MODEL}`);
});

process.once('SIGINT', () => {
	server.close();
	bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
	server.close();
	bot.stop('SIGTERM');
});
