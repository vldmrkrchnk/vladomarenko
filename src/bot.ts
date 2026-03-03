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
const IDENTITY = fs.readFileSync('identity.txt', 'utf-8');

// Force API mode from environment variable (overrides seconds check)
// Set FORCE_API=grok or FORCE_API=openai to force a specific API
const FORCE_API = process.env.FORCE_API?.toLowerCase();

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Initialize Grok client (using OpenAI SDK compatibility)
const grok = new OpenAI({
	apiKey: GROK_KEY,
	baseURL: 'https://api.x.ai/v1'
});

// GCP Cloud Storage for log files (OPTIONAL - only needed for serverless services)
let gcsBucket: any = null;
if (process.env.GCP_STORAGE_BUCKET) {
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
const GROK_LOGS_FILE = 'grok_requests.log';
const OPENAI_LOGS_FILE = 'openai_requests.log';
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
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-50), null, 2));
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

// API selection: based on current second or forced mode
function decideAPI(): string {
	if (FORCE_API === 'grok' || FORCE_API === 'openai') {
		return FORCE_API;
	}
	const now = new Date();
	const second = now.getSeconds();
	const lastDigit = second % 10;
	// Odd → OpenAI, Even → Grok
	if ([1, 3, 5, 7, 9].includes(lastDigit)) {
		return 'openai';
	}
	return 'grok';
}

// Log file writer (local or GCS)
async function appendToLogFile(filename: string, content: string) {
	if (gcsBucket) {
		try {
			const file = gcsBucket.file(`logs/${filename}`);
			const [exists] = await file.exists();
			let currentContent = '';
			if (exists) {
				try {
					const [buffer] = await file.download();
					currentContent = buffer.toString('utf-8');
				} catch (e) {
					currentContent = '';
				}
			}
			await file.save(currentContent + content, {
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
		const logFile = apiName.includes('Grok') || apiName.includes('xAI') ? GROK_LOGS_FILE : OPENAI_LOGS_FILE;
		await appendToLogFile(logFile, logEntry);
	} catch (error) {
		logger.error({ error }, `Failed to log ${apiName} request`);
	}
}

// Grok streaming response
async function getKrapralStreamFromGrok(text: string, username: string) {
	const messages = [
		{ role: 'system' as const, content: IDENTITY },
		...history.map(m => ({ role: m.role as 'user' | 'assistant', name: m.name, content: m.content })),
		{ role: 'user' as const, name: username, content: text }
	];

	const typedMessages = messages.map(m => ({
		role: m.role,
		name: ('name' in m && m.name) ? m.name.replace(/[^a-zA-Z0-9_-]/g, '_') : undefined,
		content: m.content
	}));

	try {
		const stream = await grok.chat.completions.create({
			model: 'grok-beta',
			messages: typedMessages as any,
			temperature: 1.2,
			max_tokens: 1000,
			stream: true
		});
		return stream;
	} catch (err: any) {
		logger.error({ error: { message: err.message, status: err.status, type: err.type } }, 'Grok API error');
		throw err;
	}
}

// OpenAI streaming response
async function getKrapralStreamFromOpenAI(text: string, username: string) {
	const messages = [
		{ role: 'system' as const, content: IDENTITY },
		...history.map(m => ({
			role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
			content: m.name ? `${m.name}: ${m.content}` : m.content
		})),
		{ role: 'user' as const, content: `${username}: ${text}` }
	];

	try {
		const stream = await openai.chat.completions.create({
			model: 'gpt-4o',
			messages: messages,
			temperature: 1.2,
			max_tokens: 1000,
			top_p: 0.95,
			frequency_penalty: 0.7,
			presence_penalty: 0.6,
			stream: true
		});
		return stream;
	} catch (err: any) {
		logger.error('OpenAI API error:', err.message || err);
		throw err;
	}
}

// Main stream function: decides API based on second or FORCE_API
async function getKrapralStream(text: string, username: string) {
	const api = decideAPI();
	const now = new Date();
	const second = now.getSeconds();
	logger.info(`Using ${api.toUpperCase()} API (based on current second: ${second})`);

	try {
		if (api === 'openai') {
			const result = await getKrapralStreamFromOpenAI(text, username);
			return { stream: result, api: 'openai', model: 'gpt-4o' };
		} else {
			const result = await getKrapralStreamFromGrok(text, username);
			return { stream: result, api: 'grok', model: 'grok-beta' };
		}
	} catch (error) {
		logger.warn(`Primary API ${api} failed, trying fallback...`);
		// Fallback logic
		if (api === 'openai') {
			const result = await getKrapralStreamFromGrok(text, username);
			return { stream: result, api: 'grok', model: 'grok-beta' };
		} else {
			const result = await getKrapralStreamFromOpenAI(text, username);
			return { stream: result, api: 'openai', model: 'gpt-4o' };
		}
	}
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

	const chatId = ctx.chat?.id;

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
		return;
	}

	logger.info(`[REPLY] Krapral decided to reply to "${text}" from ${username}`);
	let sentMessageInfo: any = null;
	let fullResponse = '';

	try {
		await ctx.sendChatAction('typing');

		const result = await getKrapralStream(text, username);
		const { stream, api, model } = result;
		const apiName = api === 'openai' ? `OpenAI (${model})` : `Grok (${model})`;
		logger.info(`Krapral replying to ${username} | API: ${apiName}`);

		// Send placeholder message
		sentMessageInfo = await ctx.reply('...');

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
						await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, fullResponse);
						lastEditTime = now;
						buffer = '';
					} catch (ignore) { }
				}
			}
		}

		// Final update
		if (fullResponse && buffer.length > 0) {
			try {
				await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, fullResponse);
			} catch (ignore) { }
		}

		// Log full request
		const originalMessages = [
			{ role: 'system', content: IDENTITY },
			...history.map(m => ({ role: m.role, name: m.name, content: m.content })),
			{ role: 'user', name: username, content: text }
		];
		await logRequest(api === 'grok' ? 'Grok' : 'OpenAI', originalMessages, fullResponse, username, model);
	} catch (error) {
		logger.error({ error }, 'Error during streaming response');
		fullResponse = 'Так точно... связь пропала. Пятая точка всё ещё в строю.';
		if (sentMessageInfo) {
			await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, fullResponse);
		} else {
			await ctx.reply(fullResponse);
		}
	}

	let responseText = fullResponse;
	let actionDescription = '';

	// 1. Handle reactions: [REACT:emoji]
	const reactMatch = responseText.match(/\[REACT:(.+?)\]/);
	if (reactMatch) {
		const emoji = reactMatch[1].trim();
		responseText = responseText.replace(reactMatch[0], '').trim();

		if (sentMessageInfo) {
			try {
				await ctx.telegram.editMessageText(ctx.chat.id, sentMessageInfo.message_id, undefined, responseText || '...');
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
	const messageId = msg.message_id;
	const username = formatName(msg.from);
	const text = msg.text.trim();
	const chatType = ctx.chat.type;
	await handleIncomingText(ctx, text, username, messageId, chatType);
});

// Audio/voice/video transcription handler
async function handleAudioTranscription(ctx: any) {
	const msg = ctx.message;
	if (!msg) return;
	const messageId = msg.message_id;
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

	if (FORCE_API) {
		logger.info(`MODE: ${FORCE_API.toUpperCase()} (forced, seconds ignored)`);
	} else {
		logger.info('MODE: AUTO (API chosen by second)');
	}
});

process.once('SIGINT', () => {
	server.close();
	bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
	server.close();
	bot.stop('SIGTERM');
});
