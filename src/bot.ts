// bot.ts — Крапрал 3.0: умный, спокойный, непобедимый
import { Telegraf } from 'telegraf';
import fs from 'fs';
import axios from 'axios';
import pino from 'pino';
import 'dotenv/config';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

const TOKEN = process.env.TELEGRAM_TOKEN!;
const GROK_KEY = process.env.GROK_API_KEY!;
const IDENTITY = fs.readFileSync('identity.txt', 'utf-8');

interface Msg {
	role: 'user' | 'assistant';
	name: string;       // всегда с @
	content: string;
	timestamp: number;
	message_id?: number; // добавляем ID сообщения Telegram
}

let history: Msg[] = [];
const HISTORY_FILE = 'last_50.json';
const MIN_MESSAGES_BETWEEN_RESPONSES = 3;

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
		logger.error('Ошибка загрузки истории:', e);
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
// === УМНАЯ ЛОГИКА 2025: Крапрал вмешивается только когда надо ===
function shouldKrapralSpeak(username: string, text: string): boolean {
	const lower = text.toLowerCase();

	// 1. Прямой пинг — всегда отвечаем
	if (lower.includes('крапрал') || lower.includes('@krapral') || lower.includes('krapral')) {
		logger.info(`Прямой пинг от ${username}`);
		return true;
	}

	// 2. Новый боец — зачисляем
	const squad = ['@FedotovAndrii', '@vinohradov', '@Ihorushka', '@nehoroshevVl', '@vinograd1ka', '@ynddw', '@olejatir', '@Waltons777'];
	if (!squad.includes(username)) {
		logger.info(`Новый рядовой ${username} → приветствуем`);
		return true;
	}

	// 3. Главное: не лезем в личные диалоги двух человек
	const recent = history.slice(-20);
	const userMessages = recent.filter(m => m.role === 'user');

	// Если мало сообщений — молчим
	if (userMessages.length < 5) return false;

	// Если в диалоге больше 2 человек — ок, можно выйти
	const participants = new Set(userMessages.map(m => m.name));
	if (participants.size > 2) return true;

	// Если только 2 человека переписываются уже 5+ сообщений подряд — вмешиваемся один раз
	const lastKrapralMsg = recent.reverse().find(m => m.role === 'assistant');
	const msgsSinceKrapral = lastKrapralMsg
		? recent.filter(m => m.timestamp > lastKrapralMsg.timestamp).length
		: recent.length;

	return msgsSinceKrapral >= 5;
}

// Ответ от Grok
async function getKrapralResponse(text: string, username: string): Promise<string> {
	const messages = [
		{ role: 'system', content: IDENTITY },
		...history.map(m => ({ role: m.role, name: m.name, content: m.content })),
		{ role: 'user', name: username, content: text }
	];

	try {
		const res = await axios.post('https://api.x.ai/v1/chat/completions', {
			model: 'grok-4',
			messages,
			temperature: 0.87,
			max_tokens: 500
		}, {
			headers: { Authorization: `Bearer ${GROK_KEY}` },
			timeout: 30000
		});

		return res.data.choices[0].message.content.trim();
	} catch (err: any) {
		logger.error('Grok API error:', err.response?.data || err.message);
		return 'Так точно... связь пропала. Пятая точка всё ещё в строю.';
	}
}

// === ЗАПУСК БОТА ===
const bot = new Telegraf(TOKEN);

bot.start(ctx => ctx.reply('Крапрал на посту. Пятая точка в строю.'));

// Основной обработчик
bot.on('text', async (ctx) => {
	const msg = ctx.message;
	const messageId = msg.message_id;
	const username = formatName(msg.from);
	const text = msg.text.trim();

	// КРИТИЧЕСКАЯ ЗАЩИТА: не реагируем на старые сообщения при запуске
	if (processedMessageIds.has(messageId)) {
		return; // уже видели это сообщение — молчим
	}
	processedMessageIds.add(messageId);

	// Сохраняем сообщение пользователя + его Telegram ID
	history.push({
		role: 'user',
		name: username,
		content: text,
		timestamp: Date.now(),
		message_id: messageId
	});
	saveHistory();

	// Решаем: говорить или молчать
	if (!shouldKrapralSpeak(ctx, username, text)) {
		return;
	}

	logger.info(`Крапрал отвечает ${username}`);

	const response = await getKrapralResponse(text, username);

	await ctx.reply(response);

	// Сохраняем свой ответ
	history.push({
		role: 'assistant',
		name: '@Krapral',
		content: response,
		timestamp: Date.now()
	});
	saveHistory();
});

bot.launch({ dropPendingUpdates: true }); // ← ВАЖНО: пропускаем все старые обновления при старте
logger.info('Крапрал 3.0 на боевом дежурстве. Никакого спама. Только точные удары.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));