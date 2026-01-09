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

// Accumulator for debounce logic
interface AccumulatedMessage {
	user: string;
	text: string;
	messageId: number;
	timestamp: number;
	ctx: any;
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
				const content = m.content.length > 100
					? m.content.substring(0, 100) + '...'
					: m.content;
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
				const content = m.content.length > 100
					? m.content.substring(0, 100) + '...'
					: m.content;
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
		return 'Так точно... связь пропала. Пятая точка всё ещё в строю.';
	}
}

// Ответ от OpenAI
async function getKrapralResponseFromOpenAI(text: string, username: string, messagesOverride?: any[]): Promise<string> {
	// Форматируем сообщения для OpenAI (без name поля, включаем в content)
	const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messagesOverride ?
		// If override provided, we assume it's already qualified (but OpenAI matches specifically)
		// We might need to map it if it has 'name' which OpenAI supports but strictly
		messagesOverride.map(m => ({
			role: m.role,
			content: m.name && m.role !== 'system' ? `${m.name}: ${m.content}` : m.content
		}))
		: [
			{
				role: 'system',
				content: IDENTITY
			},
			...history.map(m => ({
				role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
				content: m.name ? `${m.name}: ${m.content}` : m.content
			})),
			{
				role: 'user',
				content: `${username}: ${text}`
			}
		];

	try {
		// Use GPT-4.1 as the primary and stable chat model
		const model = 'gpt-4.1';
		const completion = await openai.chat.completions.create({
			model: model,
			messages: messages,
			temperature: 1.2, // Increased for more variety and creativity
			max_tokens: 500,
			top_p: 0.95, // Nucleus sampling for more diverse outputs
			frequency_penalty: 0.7, // Penalize repetition
			presence_penalty: 0.6 // Encourage new topics
		});

		const response = completion.choices[0]?.message?.content?.trim() || '';

		// Логируем запрос и ответ (используем оригинальный формат для лога)
		const originalMessages = [
			{ role: 'system', content: IDENTITY },
			...history.map(m => ({ role: m.role, name: m.name, content: m.content })),
			{ role: 'user', name: username, content: text }
		];
		await logOpenAIRequest(originalMessages, response, username, model);

		return response;
	} catch (err: any) {
		logger.error('OpenAI API error:', err.message || err);
		return 'Так точно... связь пропала. Пятая точка всё ещё в строю.';
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
function enqueueMessage(ctx: any, text: string, username: string, messageId: number) {
	accumulatedMessages.push({
		user: username,
		text: text,
		messageId: messageId,
		timestamp: Date.now(),
		ctx: ctx
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
	// We use the 'messagesOverride' parameter we added.
	const promptMessages = [
		{ role: 'system', content: IDENTITY },
		...history.map(m => ({ role: m.role, name: m.name, content: m.content }))
	];

	// Determine the "username" to address (usually the last one or the one who triggered)
	const targetUser = lastMsg.user;

	const result = await getKrapralResponse(lastMsg.text, targetUser, promptMessages);
	const apiName = result.api === 'openai' ? 'OpenAI (gpt-4.1)' : 'Grok (grok-4)';
	logger.info(`Крапрал отвечает (Batch) | API: ${apiName}`);

	await ctx.reply(result.response);

	// 4. Save Assistant Response
	history.push({
		role: 'assistant',
		name: '@Krapral',
		content: result.response,
		timestamp: Date.now()
	});
	saveHistory();
}

// Обработка транскрибированного текста (для голосовых сообщений)
// messageId уже добавлен в processedMessageIds при начале обработки голосового
async function handleIncomingTextAfterTranscription(ctx: any, text: string, username: string, messageId: number) {
	// messageId уже в processedMessageIds, просто добавляем в очередь
	enqueueMessage(ctx, text, username, messageId);
}

// Основной обработчик текстовых сообщений
bot.on('text', async (ctx) => {
	const msg = ctx.message;
	if (!msg || !msg.text) return;

	const messageId = msg.message_id;
	const username = formatName(msg.from);
	const text = msg.text.trim();

	await handleIncomingText(ctx, text, username, messageId);
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
	logger.info(`[НАЧАЛО ОБРАБОТКИ] Голосовое сообщение ${messageId} от ${username} - начинаю транскрипцию...`);

	try {
		// Определяем file_id в зависимости от типа сообщения
		let fileId: string;
		if (msg.voice) {
			fileId = msg.voice.file_id;
			logger.debug(`Voice message detected, file_id: ${fileId}`);
		} else if (msg.audio) {
			fileId = msg.audio.file_id;
			logger.debug(`Audio message detected, file_id: ${fileId}`);
		} else if (msg.video) {
			fileId = msg.video.file_id;
			logger.debug(`Video message detected, file_id: ${fileId}`);
		} else if (msg.video_note) {
			fileId = msg.video_note.file_id;
			logger.debug(`Video note detected, file_id: ${fileId}`);
		} else {
			logger.warn('Unknown media type in handleAudioTranscription');
			return;
		}

		// Получаем ссылку на файл
		logger.debug(`Getting file link for file_id: ${fileId}`);
		const fileLink = await ctx.telegram.getFileLink(fileId);
		logger.debug(`File link obtained: ${fileLink.toString()}`);

		// Скачиваем файл как поток (streaming, не сохраняем на диск)
		logger.debug('Downloading file stream...');
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

		// Обрабатываем транскрибированный текст как обычное текстовое сообщение
		// messageId уже в processedMessageIds, используем специальную функцию
		await handleIncomingTextAfterTranscription(ctx, transcribedText, username, messageId);

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