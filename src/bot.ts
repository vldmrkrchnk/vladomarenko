// bot.ts — Крапрал 3.0: умный, спокойный, непобедимый
import { Telegraf } from 'telegraf';
import fs from 'fs';
import axios from 'axios';
import pino from 'pino';
import OpenAI from 'openai';
import { toFile } from 'openai';
import http from 'http';
import { Readable } from 'stream';
import 'dotenv/config';
import fsPromises from 'fs/promises';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import { search } from 'duck-duck-scrape';

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
const FORCE_API = process.env.FORCE_API?.toLowerCase() as 'grok' | 'openai' | undefined;

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// GCP Cloud Storage for log files (OPTIONAL - only needed for serverless services)
// Note: 
// - Cloud Run/App Engine/Functions: Ephemeral filesystem → need Cloud Storage bucket
// - Compute Engine (VM): Can write to local files on persistent disk → bucket NOT needed
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

interface Msg {
	role: 'user' | 'assistant';
	name: string;       // всегда с @
	content: string;
	timestamp: number;
	message_id?: number; // добавляем ID сообщения Telegram
}

let history: Msg[] = [];
const HISTORY_FILE = 'last_50.json';
const GROK_LOGS_FILE = 'grok_requests.log';
const OPENAI_LOGS_FILE = 'openai_requests.log';
const MIN_MESSAGES_BETWEEN_RESPONSES = 5; // Увеличено до 5 сообщений между ответами
const USERS_FILE = 'users.json';
const DEBOUNCE_DELAY = 4000; // 4 seconds debounce

// --- PERSONALITY CONFIG ---
const MOODS = [
	"Grumpy & Cynical (hates everything modern)",
	"Nostalgic (remembers 'better times' in 2012)",
	"Tactical & Paranoiac (suspects everyone is a spy)",
	"Philosophical (contemplates the meaning of digital existence)",
	"Aggressively Motivated (drill sergeant mode)",
	"Tired Veteran (just wants to sleep, but duty calls)",
	"Darkly Humorous (finds joy in chaos)",
	"Constructive but Sarcastic (helps, but mocks)"
];

function getRandomMood(): string {
	return MOODS[Math.floor(Math.random() * MOODS.length)];
}

// Quiet Hours: 02:00 to 07:00
function isQuietHours(): boolean {
	// Use local time or adjust for timezone if needed (system time is used here)
	const hour = new Date().getHours();
	return hour >= 2 && hour < 7;
}

// --- REPETITION GUARD ---
function isRepetitive(newText: string, historyLimit: number = 10): boolean {
	const recentBotMessages = history
		.filter(m => m.role === 'assistant')
		.slice(-historyLimit)
		.map(m => m.content);

	if (recentBotMessages.length === 0) return false;

	const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\s]/gu, '').trim();
	const target = normalize(newText);

	// Check 1: Exact duplicate
	if (recentBotMessages.some(m => normalize(m) === target)) return true;

	// Check 2: Substantial overlap
	if (target.length > 20) {
		const start = target.substring(0, 20);
		if (recentBotMessages.some(m => normalize(m).startsWith(start))) return true;
	}

	return false;
}

// Accumulator for debounce logic
interface AccumulatedMessage {
	user: string;
	text: string;
	messageId: number;
	timestamp: number;
	ctx: any;
	images?: string[]; // Array of base64 images
}
let accumulatedMessages: AccumulatedMessage[] = [];
let debounceTimer: NodeJS.Timeout | null = null;

// Загружаем список известных пользователей
let knownUsers: Set<string> = new Set();
if (fs.existsSync(USERS_FILE)) {
	try {
		const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
		if (usersData.participants) {
			knownUsers = new Set(Object.keys(usersData.participants));
			logger.info(`Загружено ${knownUsers.size} известных пользователей из users.json`);
		}
	} catch (e) {
		logger.error({ error: e }, 'Ошибка загрузки users.json');
	}
}

// === ГЛАВНАЯ ЗАЩИТА ОТ СПАМА ПРИ ЗАПУСКЕ ===
const processedMessageIds = new Set<number>();

// Загрузка истории + сразу помечаем все старые сообщения как обработанные
if (fs.existsSync(HISTORY_FILE)) {
	try {
		const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
		history = Array.isArray(raw) ? raw.slice(-50) : [];

		// Помечаем ВСЕ сообщения из истории как уже обработанные
		history.forEach(msg => {
			if (msg.message_id) processedMessageIds.add(msg.message_id);
		});

		logger.info(`Загружено ${history.length} сообщений из истории → старые помечены как обработанные`);
	} catch (e) {
		logger.error({ error: e }, 'Ошибка загрузки истории');
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

// Safe reply function to handle errors (e.g. user blocked bot)
async function safeReply(ctx: any, text: string) {
	try {
		await ctx.reply(text);
	} catch (e: any) {
		logger.warn({ error: e.message, user: ctx.from?.username }, 'Failed to send reply (user blocked bot?)');
	}
}

// Должны ли мы вообще открывать рот?
// === СТРОГАЯ ЛОГИКА: Крапрал отвечает только когда действительно нужно ===
function shouldKrapralSpeak(username: string, text: string): boolean {
	const lower = text.toLowerCase();
	logger.info(`[shouldKrapralSpeak] Checking "${text}" (lower: "${lower}") from ${username}`);

	// 1. Прямой пинг — ВСЕГДА отвечаем (приоритет #1)
	const KRAPRAL_TRIGGERS = ["капрал", 'крапрал', 'krapral', '@krapral', 'краб', "крабчик", "крамар"];

	if (KRAPRAL_TRIGGERS.some(trigger => lower.includes(trigger))) {
		logger.info(`[ПРЯМОЙ ПИНГ] ${username} упомянул Крапрала → отвечаем`);
		return true;
	}

	// 2. Quiet Hours (Тихий час) - если не прямой пинг, то молчим с 02:00 до 07:00
	if (isQuietHours()) {
		logger.info(`[QUIET HOURS] Сейчас тихий час (02:00-07:00). Крапрал спит, если его не пнули лично.`);
		return false;
	}

	// 2. Quiet Hours (Тихий час) - если не прямой пинг, то молчим с 02:00 до 07:00
	if (isQuietHours()) {
		logger.info(`[QUIET HOURS] Сейчас тихий час (02:00-07:00). Крапрал спит, если его не пнули лично.`);
		return false;
	}

	// 2. Новый боец (не в users.json) — зачисляем в строй
	if (!knownUsers.has(username)) {
		logger.info(`[НОВЫЙ БОЕЦ] ${username} → приветствуем`);
		return true;
	}

	// 3. ПРОВЕРКА КУЛДАУНА: сколько сообщений прошло с последнего ответа Крапрала?
	const lastKrapralResponse = history.slice().reverse().find(m => m.role === 'assistant');
	if (!lastKrapralResponse) {
		// Если Крапрал ещё не отвечал — молчим (кроме пингов и новых бойцов)
		return false;
	}

	// Считаем сообщения ПОСЛЕ последнего ответа Крапрала
	const messagesSinceLastResponse = history.filter(m =>
		m.timestamp > lastKrapralResponse.timestamp && m.role === 'user'
	).length;

	// 4. Проверяем: есть ли в текущем сообщении вопрос?
	const currentMessageHasQuestion = /\?/.test(text) ||
		/\b(что|как|когда|где|почему|кто|отзовись|слышит|слушаешь)\b/i.test(text);

	// Если текущее сообщение содержит вопрос — отвечаем (даже если не прошло 5 сообщений)
	if (currentMessageHasQuestion) {
		logger.info(`[ВОПРОС В ТЕКУЩЕМ СООБЩЕНИИ] ${username} задал вопрос → отвечаем`);
		return true;
	}

	// Если прошло меньше MIN_MESSAGES_BETWEEN_RESPONSES сообщений — МОЛЧИМ
	if (messagesSinceLastResponse < MIN_MESSAGES_BETWEEN_RESPONSES) {
		logger.info(`[КУЛДАУН] Прошло только ${messagesSinceLastResponse} сообщений, нужно минимум ${MIN_MESSAGES_BETWEEN_RESPONSES} → молчим`);
		return false;
	}

	// 5. Если прошло достаточно сообщений, проверяем: есть ли в последних сообщениях что-то, что требует ответа?
	const recentMessages = history.slice(-10).filter(m => m.role === 'user');
	const hasQuestion = recentMessages.some(m =>
		/\?/.test(m.content) ||
		/\b(что|как|когда|где|почему|кто)\b/i.test(m.content)
	);

	// Если есть вопрос И прошло достаточно сообщений — отвечаем
	if (hasQuestion && messagesSinceLastResponse >= MIN_MESSAGES_BETWEEN_RESPONSES) {
		logger.info(`[ВОПРОС В ИСТОРИИ] ${username} задал вопрос, прошло ${messagesSinceLastResponse} сообщений → отвечаем`);
		return true;
	}

	// 6. Если прошло ОЧЕНЬ много сообщений (10+) — можно вмешаться
	if (messagesSinceLastResponse >= 10) {
		logger.info(`[ДОЛГОЕ МОЛЧАНИЕ] Прошло ${messagesSinceLastResponse} сообщений → можно ответить`);
		return true;
	}

	// Во всех остальных случаях — МОЛЧИМ
	logger.info(`[НЕТ ПРИЧИНЫ ОТВЕЧАТЬ] Прошло ${messagesSinceLastResponse} сообщений, нет вопросов, нет долгого молчания → молчим`);
	return false;
}

// Решение: какую API использовать (на основе текущей секунды или принудительного режима)
function decideAPI(): 'grok' | 'openai' {
	// Если установлен принудительный режим - используем его (без логирования, т.к. уже показано при старте)
	if (FORCE_API === 'grok' || FORCE_API === 'openai') {
		return FORCE_API;
	}

	// Иначе используем логику на основе секунды
	const now = new Date();
	const second = now.getSeconds();
	const lastDigit = second % 10;

	// Если последняя цифра 1,3,5,7,9 → OpenAI
	// Если последняя цифра 0,2,4,6,8 → Grok
	if ([1, 3, 5, 7, 9].includes(lastDigit)) {
		return 'openai';
	}
	return 'grok';
}

// Универсальная функция для записи в лог-файл (локально или в GCS)
// Note: Cloud Storage doesn't support native append, so we download, append, and re-upload
// For high-frequency logging, consider batching or using a local buffer with periodic flushes
async function appendToLogFile(filename: string, content: string): Promise<void> {
	if (gcsBucket) {
		// Write to GCP Cloud Storage
		try {
			const file = gcsBucket.file(`logs/${filename}`);
			// Получаем текущее содержимое файла (если есть)
			const [exists] = await file.exists();
			let currentContent = '';
			if (exists) {
				try {
					const [buffer] = await file.download();
					currentContent = buffer.toString('utf-8');
				} catch (e) {
					// Файл может быть пустым или недоступным
					currentContent = '';
				}
			}
			// Сохраняем с добавлением нового контента
			await file.save(currentContent + content, {
				metadata: { contentType: 'text/plain' }
			});
			// Don't log every write to avoid spam - only log errors
		} catch (error) {
			logger.error({ error }, `Failed to write ${filename} to GCS, falling back to local`);
			// Fallback to local file
			fs.appendFileSync(filename, content, 'utf-8');
		}
	} else {
		// Write to local file
		fs.appendFileSync(filename, content, 'utf-8');
		// Don't log every write to avoid spam
	}
}

// Логирование запросов к Grok
async function logGrokRequest(messages: any[], response: string, username: string): Promise<void> {
	try {
		const timestamp = new Date().toISOString();
		const identity = IDENTITY.substring(0, 30) + (IDENTITY.length > 30 ? '...' : '');

		// Форматируем сообщения для лога (исключаем system, показываем первые 100 символов)
		const messagesPreview = messages
			.filter(m => m.role !== 'system')
			.map(m => {
				const name = m.name ? `${m.name}: ` : '';
				const contentStr = m.content || '';
				const content = contentStr.length > 100
					? contentStr.substring(0, 100) + '...'
					: contentStr;
				return `  [${m.role}] ${name}${content}`;
			})
			.join('\n');

		const logEntry = `
================================================================================
[${timestamp}] Grok Request from @${username}
Model: grok-4
Identity (first 30 chars): ${identity}

Messages sent to Grok:
${messagesPreview}

Grok Response:
${response}

================================================================================
`;

		// Добавляем в лог-файл (локально или в GCS)
		await appendToLogFile(GROK_LOGS_FILE, logEntry);
	} catch (error) {
		logger.error({ error }, 'Failed to log Grok request');
	}
}

// Логирование запросов к OpenAI
async function logOpenAIRequest(messages: any[], response: string, username: string, model: string = 'gpt-4.1'): Promise<void> {
	try {
		const timestamp = new Date().toISOString();
		const identity = IDENTITY.substring(0, 30) + (IDENTITY.length > 30 ? '...' : '');

		// Форматируем сообщения для лога (исключаем system, показываем первые 100 символов)
		const messagesPreview = messages
			.filter(m => m.role !== 'system')
			.map(m => {
				const name = m.name ? `${m.name}: ` : '';
				const contentStr = m.content || (m.tool_calls ? `[Tool Call: ${m.tool_calls.length}]` : '');
				const content = (contentStr.length > 100)
					? contentStr.substring(0, 100) + '...'
					: contentStr;
				return `  [${m.role}] ${name}${content}`;
			})
			.join('\n');

		const logEntry = `
================================================================================
[${timestamp}] OpenAI Request from @${username}
Model: ${model}
Identity (first 30 chars): ${identity}

Messages sent to OpenAI:
${messagesPreview}

OpenAI Response:
${response}

================================================================================
`;

		// Добавляем в лог-файл (локально или в GCS)
		await appendToLogFile(OPENAI_LOGS_FILE, logEntry);
	} catch (error) {
		logger.error({ error }, 'Failed to log OpenAI request');
	}
}

// Ответ от Grok
async function getKrapralResponseFromGrok(text: string, username: string, messagesOverride?: any[]): Promise<string> {
	const messages = messagesOverride || [
		{ role: 'system', content: IDENTITY },
		...history.map(m => ({ role: m.role, name: m.name, content: m.content })),
		{ role: 'user', name: username, content: text }
	];

	try {
		const res = await axios.post('https://api.x.ai/v1/chat/completions', {
			model: 'grok-4',
			messages,
			temperature: 1.2, // Increased for more variety and creativity
			max_tokens: 500
			// Note: Grok API may not support top_p, frequency_penalty, presence_penalty
			// Using only temperature for Grok, OpenAI will use all parameters
		}, {
			headers: { Authorization: `Bearer ${GROK_KEY}` },
			timeout: 30000
		});

		const response = res.data.choices[0].message.content.trim();

		// Логируем запрос и ответ
		await logGrokRequest(messages, response, username);

		return response;
	} catch (err: any) {
		const errorDetails = {
			message: err.message,
			status: err.response?.status,
			statusText: err.response?.statusText,
			data: err.response?.data,
			url: err.config?.url
		};
		logger.error({ error: errorDetails }, 'Grok API error');
		return 'Связь с Grok перехвачена РЭБ противника. Повторите запрос, боец.';
	}
}

// --- TOOLS DEFINITION ---
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
	{
		type: 'function',
		function: {
			name: 'search_internet',
			description: 'Search the internet for current information, news, or specific facts. Use this when the user asks about recent events (after 2023) or current state of things.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query to execute.'
					}
				},
				required: ['query']
			}
		}
	}
];

// --- TOOL EXECUTOR ---
// --- TOOL EXECUTOR ---
async function performSearch(query: string): Promise<string> {
	logger.info(`[TOOL] Searching internet for: "${query}"`);
	try {
		const results = await search(query);
		if (!results.results || results.results.length === 0) {
			return "No search results found.";
		}

		// Format top 3 results
		const summary = results.results.slice(0, 3).map((r: any) =>
			`- Title: ${r.title}\n  Link: ${r.url}\n  Snippet: ${r.description}`
		).join('\n\n');

		return `Search Results for "${query}":\n\n${summary}`;
	} catch (error: any) {
		logger.error({ error }, `Search failed for: ${query}`);
		return `Error performing search: ${error.message}`;
	}
}
async function getKrapralResponseFromOpenAI(text: string, username: string, messagesOverride?: any[]): Promise<string> {
	// Форматируем сообщения для OpenAI (без name поля, включаем в content)
	const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messagesOverride ?
		// If override provided, we assume it's already qualified (but OpenAI matches specifically)
		// We might need to map it if it has 'name' which OpenAI supports but strictly
		messagesOverride.map(m => ({
			role: m.role,
			content: m.name && m.role !== 'system' ? `${m.name}: ${m.content}` : m.content,
			tool_calls: (m as any).tool_calls,
			tool_call_id: (m as any).tool_call_id,
			name: (m as any).name
		}))
		: [
			{
				role: 'system',
				content: `${IDENTITY}\n\nCURRENT CONTEXT:\n- Current Time: ${new Date().toLocaleTimeString()}\n- Current Mood: ${getRandomMood()} (Let this mood slightly color your response style, but keep the core persona).`
			},
			...history.map(m => ({
				role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
				content: m.name ? `${m.name}: ${m.content}` : m.content
			})),
			{
				role: 'user',
				content: `${username}: ${text}`
			},
		];

	try {
		// Use GPT-4.1 as the primary and stable chat model
		// Or 4o if vision was used (passed via model param? No, checking logic generally implies 4.1 unless vision)
		// Let's stick to 4o for everything if tools are involved? 
		// Actually 4.1 (preview) or 4-turbo is good for tools. 
		// "gpt-4o" is best for tools + vision + speed.

		const model = 'gpt-4o'; // Switched to 4o for better tool use and unify logic

		const runCompletion = async (currentMessages: any[]) => {
			return await openai.chat.completions.create({
				model: model,
				messages: currentMessages,
				temperature: 1.0,
				max_tokens: 1000,
				tools: tools,
				tool_choice: 'auto'
			});
		};

		let completion = await runCompletion(messages);
		let responseMessage = completion.choices[0].message;

		// Handle Tool Calls
		if (responseMessage.tool_calls) {
			logger.info(`[OPENAI] Tool calls detected: ${responseMessage.tool_calls.length}`);

			// Append the assistant's request to call tools
			messages.push(responseMessage);

			for (const toolCall of responseMessage.tool_calls) {
				if (toolCall.function.name === 'search_internet') {
					const args = JSON.parse(toolCall.function.arguments);
					const toolResult = await performSearch(args.query);

					messages.push({
						role: 'tool',
						tool_call_id: toolCall.id,
						content: toolResult
					});
				}
			}

			// Get final response after tools
			completion = await runCompletion(messages);
			responseMessage = completion.choices[0].message;
		}

		const response = responseMessage.content?.trim() || '';

		// Логируем запрос и ответ (используем оригинальный формат для лога)
		// Note: Logging full tool conversation might be verbose but useful
		// Re-constructing originalMessages just for the top-level log is tricky with tool interactions
		// We'll just log the final text outcome for now or the full chain if simple.

		await logOpenAIRequest(messages, response, username, model);

		return response;
	} catch (err: any) {
		logger.error('OpenAI API error:', err.message || err);
		return 'Спутники OpenAI сбиты. Перехожу на резервную частоту (попробуйте позже).';
	}
}

// Главная функция получения ответа (выбирает API на основе секунды)
async function getKrapralResponse(text: string, username: string, messagesOverride?: any[]): Promise<{ response: string; api: 'grok' | 'openai' }> {
	const api = decideAPI();
	const now = new Date();
	const second = now.getSeconds();
	logger.info(`Using ${api.toUpperCase()} API (based on current second: ${second})`);

	let response: string;
	if (api === 'openai') {
		response = await getKrapralResponseFromOpenAI(text, username, messagesOverride);
	} else {
		response = await getKrapralResponseFromGrok(text, username, messagesOverride);
	}

	return { response, api };
}

// === ЗАПУСК БОТА ===
const bot = new Telegraf(TOKEN);

bot.start(ctx => ctx.reply('Крапрал на посту. Пятая точка в строю.'));

// Обработка входящего текста (используется для текстовых сообщений)
// Добавляем сообщение в очередь (debounce)
function enqueueMessage(ctx: any, text: string, username: string, messageId: number, images?: string[]) {
	accumulatedMessages.push({
		user: username,
		text: text,
		messageId: messageId,
		timestamp: Date.now(),
		ctx: ctx,
		images: images
	});

	logger.info(`[DEBOUNCE] Message buffered from ${username}. Queue size: ${accumulatedMessages.length}`);

	if (debounceTimer) {
		clearTimeout(debounceTimer);
	}

	debounceTimer = setTimeout(async () => {
		await processAccumulatedMessages();
	}, DEBOUNCE_DELAY);
}

// Обработка входящего текста (используется для текстовых сообщений)
async function handleIncomingText(ctx: any, text: string, username: string, messageId: number) {
	// КРИТИЧЕСКАЯ ЗАЩИТА: не реагируем на старые сообщения при запуске
	if (processedMessageIds.has(messageId)) {
		logger.debug(`[ПРОПУСК] Текстовое сообщение ${messageId} от ${username} уже обработано`);
		return; // уже видели это сообщение — молчим
	}
	processedMessageIds.add(messageId);

	enqueueMessage(ctx, text, username, messageId);
}

// Обработка фото
async function handleIncomingPhoto(ctx: any) {
	const msg = ctx.message;
	if (!msg || !msg.photo) return;

	const messageId = msg.message_id;
	const username = formatName(msg.from);
	const caption = msg.caption || ''; // Фото может быть без подписи

	if (processedMessageIds.has(messageId)) return;
	processedMessageIds.add(messageId);

	try {
		// Берем самое большое фото
		const photo = msg.photo[msg.photo.length - 1];
		const fileId = photo.file_id;
		const fileLink = await ctx.telegram.getFileLink(fileId);

		const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
		const base64Image = Buffer.from(response.data, 'binary').toString('base64');
		const dataUrl = `data:image/jpeg;base64,${base64Image}`;

		logger.info(`[PHOTO] Received photo from ${username}`);
		enqueueMessage(ctx, caption, username, messageId, [dataUrl]);
	} catch (error) {
		logger.error({ error }, `Failed to process photo from ${username}`);
		await safeReply(ctx, 'Товарищ боец, фото потеряно в тумане войны. Попробуйте еще раз.');
	}
}

// Video processor: returns array of base64 images (frames)
async function processVideo(videoUrl: string): Promise<string[]> {
	const tempFile = path.join(os.tmpdir(), `vid_${Date.now()}_${Math.random().toString(36).substring(7)}.mp4`);
	const outputPattern = path.join(os.tmpdir(), `frame_${Date.now()}_%d.jpg`);

	try {
		// 1. Download video
		const w = await axios.get(videoUrl, { responseType: 'stream' });
		await fsPromises.writeFile(tempFile, w.data);

		// 2. Extract 3 frames (start, middle, end logic is hard with ffmpeg directly without probing duration first)
		// Simpler: Just take frames at 1s, 3s, 5s (if possible) or just 3 evenly spaced if we probe duration.
		// Let's probe duration first.

		const duration: number = await new Promise((resolve, reject) => {
			ffmpeg.ffprobe(tempFile, (err, metadata) => {
				if (err) return reject(err);
				resolve(metadata.format.duration || 0);
			});
		});

		const timestamps = duration > 0
			? [0.1 * duration, 0.5 * duration, 0.9 * duration]
			: [0]; // fallback

		const frames: string[] = [];

		// Extract frames one by one (async parallel would be faster but sequence is safer)
		for (let i = 0; i < timestamps.length; i++) {
			const time = timestamps[i];
			const framePath = outputPattern.replace('%d', i.toString());

			await new Promise<void>((resolve, reject) => {
				ffmpeg(tempFile)
					.screenshots({
						timestamps: [time],
						filename: path.basename(framePath),
						folder: path.dirname(framePath),
						size: '640x?' // resize to reasonable analysis size
					})
					.on('end', () => resolve())
					.on('error', (e) => reject(e));
			});

			if (fs.existsSync(framePath)) {
				const imgData = await fsPromises.readFile(framePath, { encoding: 'base64' });
				frames.push(`data:image/jpeg;base64,${imgData}`);
				await fsPromises.unlink(framePath).catch(() => { }); // cleanup frame
			}
		}

		return frames;
	} catch (e) {
		logger.error({ error: e }, 'Video processing failed');
		return [];
	} finally {
		// Clean up video file
		await fsPromises.unlink(tempFile).catch(() => { });
	}
}

// Logic to process the accumulated batch
async function processAccumulatedMessages() {
	if (accumulatedMessages.length === 0) return;

	// Snapshot and clear
	const batch = [...accumulatedMessages];
	accumulatedMessages = [];
	debounceTimer = null;

	// Sort by timestamp just in case
	batch.sort((a, b) => a.timestamp - b.timestamp);

	logger.info(`[BATCH] Processing ${batch.length} messages`);

	// 1. Add ALL messages to history first
	batch.forEach(msg => {
		history.push({
			role: 'user',
			name: msg.user,
			content: msg.text,
			timestamp: msg.timestamp,
			message_id: msg.messageId
		});
	});
	saveHistory();

	// 2. Decide if we should speak based on the entire batch
	// We check if ANY message in the batch triggers a response
	const lastMsg = batch[batch.length - 1];
	const ctx = lastMsg.ctx; // Reply using the context of the last message

	// Check triggers across the whole batch
	let shouldSpeak = false;
	let triggerReason = '';

	// Check 1: Direct triggers in ANY message
	const combinedText = batch.map(b => b.text).join(' . ');
	const KRAPRAL_TRIGGERS = ["капрал", 'крапрал', 'krapral', '@krapral', 'краб', "крабчик", "крамар"];
	if (KRAPRAL_TRIGGERS.some(trigger => combinedText.toLowerCase().includes(trigger))) {
		shouldSpeak = true;
		triggerReason = 'Direct trigger in batch';
	}

	// Check 2: New User (any in batch) -> Checked via knownUsers against each user? 
	// The original logic checked knownUsers inside shouldKrapralSpeak. 
	// We should probably rely on the existing function for consistency but adapt it.

	if (!shouldSpeak) {
		// Iterate and check standard logic for each
		for (const msg of batch) {
			// Note: This calls the ORIGINAL shouldKrapralSpeak which checks history.
			// Since we just added all items to history, the "history" check inside might be slightly skewed
			// because "messagesSinceLastResponse" will include the current batch items we just added.
			// This is actually GOOD: it means larger batches increase the "count" automatically.
			if (shouldKrapralSpeak(msg.user, msg.text)) {
				shouldSpeak = true;
				triggerReason = `Logic for msg from ${msg.user}`;
				break;
			}
		}
	}

	if (!shouldSpeak) {
		logger.info(`[BATCH SILENCE] Processed ${batch.length} messages, decided not to answer.`);
		return;
	}

	logger.info(`[BATCH REPLY] Decided to answer. Reason: ${triggerReason}`);

	// 3. Generate Response
	// We need to pass the FULL history (which now includes the batch) to the AI.

	// Check if we have visual content (images) in the batch
	const allImages = batch.flatMap(m => m.images || []);
	let modelToUse = 'gpt-4.1'; // Default
	let apiToUse: 'grok' | 'openai' = 'grok'; // Default per schedule unless vision needed
	// Wait, we need to respect the original logic BUT if vision is needed we MUST use OpenAI

	let messagesForAi: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

	if (allImages.length > 0) {
		logger.info(`[VISION] Detected ${allImages.length} images in batch -> Forcing OpenAI (gpt-4o)`);
		apiToUse = 'openai';
		modelToUse = 'gpt-4o'; // Use 4o for vision

		// Construct vision-compatible messages
		messagesForAi = [
			{ role: 'system', content: IDENTITY },
			...history.map(m => ({
				role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
				content: m.name ? `${m.name}: ${m.content}` : m.content
			}))
		];

		// Add the current batch as a single multi-modal user message
		const textContent = batch.map(m => `${m.user}: ${m.text}`).join('\n');
		const contentBlock: any[] = [{ type: 'text', text: textContent }];

		allImages.forEach(img => {
			contentBlock.push({
				type: 'image_url',
				image_url: { url: img, detail: 'low' } // low detail is cheaper and usually sufficient for context
			});
		});

		messagesForAi.push({
			role: 'user',
			content: contentBlock
		});

	} else {
		// Standard text-only flow
		const { api } = await getKrapralResponse(lastMsg.text, lastMsg.user, []); // Just to get API decision
		apiToUse = api;

		// Standard formatting
		messagesForAi = [
			{ role: 'system', content: IDENTITY },
			...history.map(m => ({ role: m.role, name: m.name, content: m.content })),
			// Add batch texts
			...batch.map(m => ({
				role: 'user' as const,
				content: `${m.user}: ${m.text}`
			}))
		];
	}

	// Helper to call OpenAI with override
	let resultText = '';
	if (apiToUse === 'openai') {
		resultText = await getKrapralResponseFromOpenAI('', lastMsg.user, messagesForAi);
	} else {
		// Grok fallback (no images)
		// We can't really pass the "batch" structure comfortably to Grok function as it expects standard text
		// So we combine text manually and call usual function
		const fullText = batch.map(m => m.text).join('\n---\n');
		resultText = await getKrapralResponseFromGrok(fullText, batch[0].user); // Approximation
	}

	const apiName = apiToUse === 'openai' ? `OpenAI (${modelToUse})` : 'Grok (grok-4)';
	logger.info(`Крапрал отвечает (Batch) | API: ${apiName}`);

	await safeReply(ctx, resultText);

	// 4. Save Assistant Response
	history.push({
		role: 'assistant',
		name: '@Krapral',
		content: resultText,
		timestamp: Date.now()
	});
	saveHistory();
}

// Обработка транскрибированного текста (для голосовых) + теперь и для Visual Context
async function handleIncomingTextAfterTranscription(ctx: any, text: string, username: string, messageId: number, images?: string[]) {
	enqueueMessage(ctx, text, username, messageId, images);
}

// Основной обработчик текстовых сообщений
bot.on('text', async (ctx) => {
	const msg = ctx.message;
	if (!msg || !msg.text) return;

	const messageId = msg.message_id;
	const username = formatName(msg.from);
	const text = msg.text.trim();

	try {
		await handleIncomingText(ctx, text, username, messageId);
	} catch (e: any) {
		logger.error({ error: e }, 'Error in text handler');
		await safeReply(ctx, 'Боец, у нас помехи. Повторите сообщение.');
	}
});

// Обработка аудио/голосовых/видео сообщений с транскрипцией
async function handleAudioTranscription(ctx: any) {
	const msg = ctx.message;
	if (!msg) return;

	const messageId = msg.message_id;
	const username = formatName(ctx.from);

	// КРИТИЧЕСКАЯ ЗАЩИТА: не реагируем на старые сообщения
	if (processedMessageIds.has(messageId)) {
		logger.info(`[ПРОПУСК] Голосовое сообщение ${messageId} от ${username} уже обрабатывается или обработано`);
		return;
	}

	// ВАЖНО: Добавляем messageId СРАЗУ, чтобы предотвратить параллельную обработку
	// Если придет еще одно голосовое во время обработки этого - оно будет пропущено
	processedMessageIds.add(messageId);
	logger.info(`[НАЧАЛО ОБРАБОТКИ] Голосовое/Видео сообщение ${messageId} от ${username} - начинаю транскрипцию...`);

	try {
		// Определяем file_id в зависимости от типа сообщения и является ли это видео
		let fileId: string;
		let isVideo = false;

		if (msg.voice) {
			fileId = msg.voice.file_id;
			logger.debug(`Voice message detected, file_id: ${fileId}`);
		} else if (msg.audio) {
			fileId = msg.audio.file_id;
			logger.debug(`Audio message detected, file_id: ${fileId}`);
		} else if (msg.video) {
			fileId = msg.video.file_id;
			isVideo = true;
			logger.debug(`Video message detected, file_id: ${fileId}`);
		} else if (msg.video_note) {
			fileId = msg.video_note.file_id;
			isVideo = true;
			logger.debug(`Video note detected, file_id: ${fileId}`);
		} else {
			logger.warn('Unknown media type in handleAudioTranscription');
			return;
		}

		// Получаем ссылку на файл
		logger.debug(`Getting file link for file_id: ${fileId}`);
		const fileLink = await ctx.telegram.getFileLink(fileId);
		logger.debug(`File link obtained: ${fileLink.toString()}`);

		let frames: string[] = [];

		// Если это видео, запускаем извлечение кадров ПАРАЛЛЕЛЬНО с транскрипцией (или перед ней)
		// Нам нужен файл для транскрипции и URL для кадров.
		// Axios поток ниже вычитывается полностью, поэтому нам придется скачать файл дважды или буферизировать.
		// Проще всего: 
		// 1. Если видео -> videoProcessor скачивает его сам через URL.
		// 2. Аудио транскрипция -> скачивает поток.

		if (isVideo) {
			logger.info(`[VIDEO] Extracting frames from video...`);
			// Запускаем асинхронно, но ждем результат
			frames = await processVideo(fileLink.toString());
			logger.info(`[VIDEO] Extracted ${frames.length} frames`);
		}

		// Скачиваем файл как поток (streaming, не сохраняем на диск)
		logger.debug('Downloading file stream for transcription...');
		const response = await axios.get(fileLink.toString(), {
			responseType: 'stream'
		});

		// Конвертируем axios stream в чистый Node.js Readable stream для OpenAI
		// OpenAI требует чистый Readable stream без axios-специфичных свойств
		logger.debug('Converting stream to buffer...');
		const chunks: Buffer[] = [];
		for await (const chunk of response.data) {
			chunks.push(Buffer.from(chunk));
		}
		const audioBuffer = Buffer.concat(chunks);
		logger.debug(`Audio buffer size: ${audioBuffer.length} bytes`);

		// OpenAI SDK требует File объект для Node.js
		// Используем toFile() для конвертации Buffer в File
		logger.debug('Converting buffer to File...');
		const audioFile = await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' });

		// Транскрибируем через OpenAI Whisper
		logger.debug('Sending to OpenAI Whisper...');
		const transcript = await openai.audio.transcriptions.create({
			model: 'whisper-1',
			file: audioFile,
			language: 'ru'
		});

		const transcribedText = transcript.text.trim();

		if (!transcribedText) {
			logger.warn(`Empty transcription for audio message from ${username}`);
			return; // Молча игнорируем, если не удалось распознать
		}

		logger.info(`[ТРАНСКРИПЦИЯ ЗАВЕРШЕНА] Голосовое ${messageId} от ${username}: "${transcribedText}"`);

		// Обрабатываем транскрибированный текст + кадры (если были)
		// messageId уже в processedMessageIds, используем специальную функцию
		await handleIncomingTextAfterTranscription(ctx, transcribedText, username, messageId, frames);

	} catch (error: any) {
		logger.error({
			error: error?.message || error,
			stack: error?.stack,
			response: error?.response?.data,
			status: error?.response?.status,
			username,
			messageId
		}, `[ОШИБКА ТРАНСКРИПЦИИ] Голосовое сообщение ${messageId} от ${username}`);
		// ВАЖНО: messageId уже в processedMessageIds, поэтому повторная обработка не произойдет
		// Это нормально - лучше пропустить одно сообщение, чем обрабатывать дубликаты
		// Молча игнорируем ошибки, не отправляем сообщения в чат
	}
}

// Обработчики для всех типов медиа с аудио
bot.on(['voice', 'audio', 'video', 'video_note'], handleAudioTranscription);
// Обработчик для фото
bot.on('photo', handleIncomingPhoto);

// HTTP сервер для Cloud Run (health checks + webhook endpoint)
// Cloud Run требует, чтобы контейнер слушал на порту (передается через переменную PORT)
const PORT = process.env.PORT || 8080;
const server = http.createServer(async (req, res) => {
	// Health check endpoint
	if (req.url === '/health' || req.url === '/') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', service: 'krapral-bot' }));
		return;
	}

	// Telegram webhook endpoint
	if (req.url === '/webhook' && req.method === 'POST') {
		let body = '';
		req.on('data', (chunk) => { body += chunk.toString(); });
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

	// 404 for other routes
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not Found');
});

server.listen(PORT, async () => {
	logger.info(`HTTP server listening on port ${PORT}`);

	// Use webhooks in production (Cloud Run), polling in development
	if (process.env.NODE_ENV === 'production' || process.env.USE_WEBHOOK === 'true') {
		// Webhook mode for Cloud Run
		// Get the service URL from environment (Cloud Run sets K_SERVICE_URL) or use WEBHOOK_URL
		const webhookUrl = process.env.WEBHOOK_URL || process.env.K_SERVICE_URL
			? `${process.env.WEBHOOK_URL || process.env.K_SERVICE_URL}/webhook`
			: null;

		if (webhookUrl) {
			try {
				await bot.telegram.setWebhook(webhookUrl);
				logger.info(`Webhook set to: ${webhookUrl}`);
				logger.info('Крапрал 3.0 на боевом дежурстве (Webhook mode)');
			} catch (err) {
				logger.error({ error: err }, 'Failed to set webhook, falling back to polling');
				// Fallback to polling if webhook fails
				bot.launch({ dropPendingUpdates: true });
			}
		} else {
			logger.warn('WEBHOOK_URL not set, using polling mode');
			bot.launch({ dropPendingUpdates: true });
		}
	} else {
		// Polling mode for local development
		bot.launch({ dropPendingUpdates: true });
		logger.info('Крапрал 3.0 на боевом дежурстве (Polling mode)');
	}

	// Показываем режим работы при запуске
	if (FORCE_API) {
		logger.info(`РЕЖИМ: ${FORCE_API.toUpperCase()} (принудительный, секунды игнорируются)`);
	} else {
		logger.info('Режим: АВТО (выбор API по секунде)');
	}
});

// Graceful shutdown
process.once('SIGINT', () => {
	logger.info('SIGINT received, shutting down gracefully...');
	server.close();
	bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
	logger.info('SIGTERM received, shutting down gracefully...');
	server.close();
	bot.stop('SIGTERM');
});