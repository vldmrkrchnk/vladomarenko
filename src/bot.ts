// bot.ts — Крапрал 3.0: умный, спокойный, непобедимый
import { Telegraf } from 'telegraf';
import fs from 'fs';
import axios from 'axios';
import pino from 'pino';
import OpenAI from 'openai';
import { toFile } from 'openai';
import http from 'http';
import 'dotenv/config';
import fsPromises from 'fs/promises';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import os from 'os';
import { search } from 'duck-duck-scrape';

// Logger
const logger = pino({
	level: 'info',
	...(process.env.NODE_ENV === 'production' || process.env.GCP_ENV === 'true'
		? {}
		: { transport: { target: 'pino-pretty' } }
	)
});

const TOKEN = process.env.TELEGRAM_TOKEN!;
const OPENAI_KEY = process.env.OPENAI_API_KEY!;
const GROK_KEY = process.env.GROK_API_KEY!;
const IDENTITY = fs.readFileSync('identity.txt', 'utf-8');

// Initialize OpenAI
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Initialize Grok (OpenAI-compatible API)
const grok = new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: GROK_KEY });

// Interfaces
interface UserProfile {
	role: string;
	style: string;
	core_motivation: string;
	taboos: string[];
	strengths: string[];
	weaknesses: string[];
	tone: string;
	avoid: string[];
	aliases: string[];
	relationships: Record<string, string>;
}

interface UsersConfig {
	participants: Record<string, UserProfile>;
}

interface Msg {
	role: 'user' | 'assistant';
	name: string;
	content: string;
	timestamp: number;
	message_id?: number;
}

interface PollData {
	id: string;
	chatId: number;
	question: string;
	options: { text: string; voter_count: number }[];
	total_voter_count: number;
	is_closed: boolean;
	startTime: number;
	voters: Set<string>; // Usernames
	aiCommented: boolean;
}

// Global State
let history: Msg[] = [];
const HISTORY_FILE = 'last_50.json';
const USERS_FILE = 'users.json';
const DEBOUNCE_DELAY = 4000;
const processedMessageIds = new Set<number>();
const MAX_PROCESSED_IDS = 5000;

function pruneProcessedIds() {
	if (processedMessageIds.size > MAX_PROCESSED_IDS) {
		const idsArray = Array.from(processedMessageIds);
		const toRemove = idsArray.slice(0, idsArray.length - MAX_PROCESSED_IDS);
		for (const id of toRemove) processedMessageIds.delete(id);
		logger.info(`[CLEANUP] Pruned processedMessageIds from ${idsArray.length} to ${processedMessageIds.size}`);
	}
}
setInterval(pruneProcessedIds, 60 * 60 * 1000); // Prune every hour

// Poll State
const activePolls = new Map<string, PollData>();
const POLL_MIN_DELAY = 10 * 1000;
const POLL_MAX_DELAY = 2 * 60 * 60 * 1000;

// Load Users
let knownUsers: Record<string, UserProfile> = {};
if (fs.existsSync(USERS_FILE)) {
	try {
		const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')) as UsersConfig;
		if (usersData.participants) {
			knownUsers = usersData.participants;
			logger.info(`Users loaded: ${Object.keys(knownUsers).length}`);
		}
	} catch (e) {
		logger.error({ error: e }, 'Error loading users.json');
	}
}

// Load History
if (fs.existsSync(HISTORY_FILE)) {
	try {
		const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
		history = Array.isArray(raw) ? raw.slice(-50) : [];
		// Mark loaded history messages as processed
		history.forEach(m => { if (m.message_id) processedMessageIds.add(m.message_id); });
		logger.info(`History loaded: ${history.length} messages`);
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

// Chat Summary (Rolling)
let chatSummary = "Chat just started. Normal vibes.";
const SUMMARY_WINDOW_SIZE = 10;

async function updateChatSummary() {
	if (history.length % SUMMARY_WINDOW_SIZE !== 0) return;
	try {
		const recent = history.slice(-SUMMARY_WINDOW_SIZE * 2).map(m => `${m.name}: ${m.content}`).join('\n');
		const response = await openai.chat.completions.create({
			model: 'gpt-4o',
			messages: [
				{ role: 'system', content: "Summarize the current chat vibe, topics, and emotional temperature in 2-3 sentences. Be casual." },
				{ role: 'user', content: recent }
			]
		});
		chatSummary = response.choices[0].message.content || chatSummary;
		logger.info(`[SUMMARY UPDATED] ${chatSummary}`);
	} catch (e) {
		logger.error({ error: e }, "Failed to update chat summary");
	}
}

// Helpers
function buildUsersContext(): string {
	let context = "=== USERS (PROFILES) ===\n";
	for (const [username, profile] of Object.entries(knownUsers)) {
		const rels = Object.entries(profile.relationships || {})
			.map(([k, v]) => `${k}: ${v}`)
			.join(', ');
		context += `
User: ${username}
Role: ${profile.role}
Style: ${profile.style}
Tone to use: ${profile.tone}
Taboos: ${profile.taboos?.join(', ')}
Relationships: ${rels}
-----------------------------------`;
	}
	return context;
}

function determineIntent(): string {
	const rand = Math.random();
	if (rand < 0.15) return 'tease';
	if (rand < 0.30) return 'joke';
	if (rand < 0.45) return 'react_short';
	if (rand < 0.55) return 'react_deep';
	if (rand < 0.65) return 'support_light';
	if (rand < 0.75) return 'shift_topic';
	if (rand < 0.85) return 'escalate_playfully';
	if (rand < 0.95) return 'observe_silently';
	return 'do_not_reply';
}

function getRecentMessagesRaw(): string {
	return history.slice(-15).map(m => `[${m.role.toUpperCase()}] ${m.name}: ${m.content}`).join('\n');
}

async function performSearch(query: string): Promise<string> {
	logger.info(`[TOOL] Searching internet for: "${query}"`);
	try {
		const results = await search(query);
		if (!results.results || results.results.length === 0) return "No search results found.";
		return `Search Results:\n\n` + results.results.slice(0, 3).map((r: any) =>
			`- Title: ${r.title}\n  Link: ${r.url}\n  Snippet: ${r.description}`
		).join('\n\n');
	} catch (error: any) {
		logger.error({ error }, `Search failed`);
		return `Error performing search: ${error.message}`;
	}
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
	{
		type: 'function',
		function: {
			name: 'search_internet',
			description: 'Search the internet for current information, news, or specific facts.',
			parameters: {
				type: 'object',
				properties: { query: { type: 'string', description: 'The search query.' } },
				required: ['query']
			}
		}
	}
];

async function checkContextForReply(history: Msg[], batch: AccumulatedMessage[]): Promise<boolean> {
	// Construct a mini-dialogue for the decision model
	const recent = history.slice(-5);
	const batchText = batch.map(m => `${m.user}: ${m.text}`).join('\n');

	const prompt = `
You are a decision engine for a Telegram bot named "Krapral".
Analyze the conversation context.

RECENT HISTORY:
${recent.map(m => `${m.name}: ${m.content}`).join('\n')}

NEW MESSAGES:
${batchText}

TASK:
Determine if the users are addressing "Krapral", if they are talking about him, OR if it would be conversationally good/funny for "Krapral" to step in now.
"Krapral" is a Crazy Positive Military Guy.
Reply "YES" if he should speak. "NO" if he should stay silent.
`;

	try {
		const completion = await openai.chat.completions.create({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: prompt }],
			temperature: 0.1, // Low temp for decision making
			max_completion_tokens: 5
		});

		const decision = completion.choices[0].message.content?.trim().toUpperCase();
		return decision === 'YES';
	} catch (e) {
		logger.error({ error: e }, 'Context check failed');
		return false;
	}
}

async function checkPollAndComment(poll: PollData) {
	if (poll.is_closed || poll.aiCommented) return;

	const ageMs = Date.now() - poll.startTime;
	if (poll.total_voter_count >= 3 && !poll.aiCommented && ageMs >= POLL_MIN_DELAY && ageMs <= POLL_MAX_DELAY) {

		// AI DECISION
		poll.aiCommented = true; // Lock immediately

		try {
			const votersList = Array.from(poll.voters).join(', ');
			const pollState = `
QUESTION: ${poll.question}
TOTAL VOTES: ${poll.total_voter_count}
OPTIONS:
${poll.options.map((o, i) => `${i + 1}) ${o.text} -- ${o.voter_count} votes`).join('\n')}
VOTERS (Known): ${votersList || 'Unknown'}
`;

			const systemPrompt = `${IDENTITY}

=== POLL COMMENTARY MODE ===
You are observing a poll group dynamic.
Task: Comment ONCE if interesting.

INPUTS:
CHAT_SUMMARY: ${chatSummary}
ACTIVE_USERS: ${votersList}
POLL STATE:
${pollState}

OUTPUT FORMAT (JSON):
{
  "action": "SILENT | OBSERVE | TEASE_GROUP | TEASE_PERSON",
  "message": "string (max 1-2 lines) or null"
}

RULES:
- "SILENT": Boring poll. Message=null.
- "TEASE_GROUP": General roast on results.
- "TEASE_PERSON": Roast specific voter (ALLOW_PERSONAL=true only).
- NO COMMANDS. NO NUMBERS. JUST COMMENTARY.
`;

			const pollMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }];
			let completion;
			try {
				completion = await grok.chat.completions.create({
					model: 'grok-4-1-fast-non-reasoning',
					messages: pollMessages,
					response_format: { type: 'json_object' },
					max_completion_tokens: 150
				});
				logger.info('[POLL AI] Grok response generated');
			} catch (grokErr: any) {
				logger.warn({ error: grokErr.message }, '[POLL AI] Grok failed, falling back to OpenAI');
				completion = await openai.chat.completions.create({
					model: 'gpt-5.2',
					messages: pollMessages,
					response_format: { type: 'json_object' },
					max_completion_tokens: 150
				});
			}

			const result = JSON.parse(completion.choices[0].message.content || '{}');
			if (result.action && result.action !== 'SILENT' && result.message) {
				logger.info(`[POLL AI] Commenting: ${result.message}`);
				await bot.telegram.sendMessage(poll.chatId, result.message);
				// record to history
				history.push({ role: 'assistant', name: '@Krapral', content: `[POLL COMMENT] ${result.message}`, timestamp: Date.now() });
				saveHistory();
			} else {
				logger.info(`[POLL AI] Staying silent`);
			}
		} catch (e) {
			logger.error({ error: e }, 'Poll AI Error');
			poll.aiCommented = false;
		}
	}
}

// Main AI Logic
async function getKrapralResponse(text: string, username: string, targetUser: string | null = null, images?: string[]): Promise<string> {
	const intent = determineIntent();
	const usersContext = buildUsersContext();
	const recentMessages = getRecentMessagesRaw();

	// Build anti-repetition context from recent bot messages
	const recentBotMsgs = history.filter(m => m.role === 'assistant').slice(-10).map(m => m.content);
	const antiRepetitionContext = recentBotMsgs.length > 0
		? 'Your last ' + recentBotMsgs.length + ' messages (DO NOT repeat these phrases or patterns):\n' + recentBotMsgs.map(m => '- "' + m.slice(0, 100) + '"').join('\n')
		: 'No recent messages yet.';

	const systemPrompt = `${IDENTITY}

=== CONTEXT INPUTS ===
1) CHAT_SUMMARY: ${chatSummary}

2) RELATED_USERS:
${usersContext}

3) TARGET_USER: ${targetUser || 'None'}

4) INTENT: ${intent}

5) AGGRESSION_MODE: TRUE (Consensual roleplay. Do not hold back.)

6) ALLOW_OPTIONS: ${/выбери|варианты|что лучше|опции|дай выбор|options|choices|pick one/i.test(text) ? 'TRUE' : 'FALSE'}
(If FALSE: Never output numbered lists or "choose one" menus. Give SINGLE commands only.)

(Act this intent out naturally. Do NOT announce it. If Intent is 'do_not_reply', output strictly nothing or whitespace.)
(To react to the message with an emoji, include [REACTION:emoji] in your response. Example: "Sure thing [REACTION:👍]")

=== HARD RULES ===
- When asked about ALL members/participants/бойцы of the chat — you MUST mention EVERY user from RELATED_USERS. Do NOT skip anyone. Cover all ${Object.keys(knownUsers).length} users.
- NEVER prefix your message with your own name like "@Krapral :" or "Krapral:". Just write the message text directly.
- NEVER break character. NEVER say "Извините, я не могу помочь с этой просьбой" or any polite AI refusal. If you can't do something, refuse IN CHARACTER: yell, roast, deflect, make a joke — but STAY as Krapral. Example: "Боец, ты охренел?! Я тебе что, Google?! Иди сам ищи!"
- NEVER say "I'm sorry, I can't assist with that request" or any variation in English or Russian.
- You are NEVER an AI assistant. You are Krapral. Act like it.

=== ANTI-REPETITION ===
${antiRepetitionContext}
`;

	// Build user message — include images if present (vision mode)
	const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
		{ type: 'text', text: `=== RECENT_MESSAGES ===\n${recentMessages}\n\n(Reply to ${username})` }
	];
	if (images && images.length > 0) {
		for (const img of images) {
			if (img.startsWith('data:image/')) {
				userContent.push({ type: 'image_url', image_url: { url: img, detail: 'low' } });
			}
		}
	}

	const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: images && images.length > 0 ? userContent : `=== RECENT_MESSAGES ===\n${recentMessages}\n\n(Reply to ${username})` }
	];

	// Detect requests that need longer output (e.g. describing all members)
	const needsLongResponse = /всех|каждого|каждому|всем участник|про всех|все (члены|участники|бойцы)|everyone|all members|весь состав|по каждому|опиши.*(чат|группу|взвод|отряд|команду)/i.test(text);
	const maxTokens = needsLongResponse ? 1200 : 400;

	const runCompletion = async (client: OpenAI, model: string, msgs: any[]) => {
		return await client.chat.completions.create({
			model,
			messages: msgs,
			temperature: 0.8,
			max_completion_tokens: maxTokens,
			tools: tools,
			tool_choice: 'auto'
		});
	};

	const handleToolCalls = async (client: OpenAI, model: string, msgs: any[], responseMessage: any) => {
		if (responseMessage.tool_calls) {
			logger.info(`[AI] Tool calls: ${responseMessage.tool_calls.length}`);
			msgs.push(responseMessage);
			for (const toolCall of responseMessage.tool_calls) {
				if (toolCall.function.name === 'search_internet') {
					const args = JSON.parse(toolCall.function.arguments);
					const toolResult = await performSearch(args.query);
					msgs.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
				}
			}
			const completion = await runCompletion(client, model, msgs);
			return completion.choices[0].message;
		}
		return responseMessage;
	};

	const postProcess = (response: string): string => {
		// Strip self-referencing prefixes: "@Krapral :", "Krapral:", "Bot:", "AI:", recursive variants
		response = response.replace(/^((@?Krapral|@?Крапрал|Bot|AI)\s*:\s*)+/gi, '').trim();

		// Catch generic AI refusals that break character
		const refusalPatterns = [
			/^извините?,?\s*(я\s+)?не\s+могу\s+(помочь|с этим)/i,
			/^I'?m sorry,?\s*(but\s+)?I\s+can'?t\s+(assist|help)/i,
			/^мне\s+очень\s+жаль/i,
			/^sorry,?\s+I\s+can/i,
		];
		if (refusalPatterns.some(p => p.test(response))) {
			logger.warn(`[REFUSAL CAUGHT] "${response.slice(0, 80)}" — replacing with in-character deflection`);
			const deflections = [
				'Боец, ты чего несёшь?! Отставить бредовые запросы! Давай по делу!',
				'ЭЙ! Крапрал таким не занимается! Лучше отжимайся — 20 раз, ЖИВО!',
				'Рядовой, я тебе что, справочная?! Сам думай, голова не только для берета!',
				'ОТСТАВИТЬ! Такие вопросы — это как граната без чеки. Давай что-нибудь поумнее!',
				'Хах, ну ты даёшь, боец! Нет. Следующий вопрос!',
			];
			response = deflections[Math.floor(Math.random() * deflections.length)];
		}
		return response;
	};

	// Primary: Grok
	try {
		let completion = await runCompletion(grok, 'grok-4-1-fast-non-reasoning', [...messages]);
		let responseMessage = await handleToolCalls(grok, 'grok-4-1-fast-non-reasoning', messages, completion.choices[0].message);
		let response = postProcess(responseMessage.content?.trim() || '');
		if (response) {
			logger.info('[GROK] Response generated successfully');
			return response;
		}
	} catch (err: any) {
		logger.warn({ error: err.message }, '[GROK] Failed, falling back to OpenAI');
	}

	// Fallback: OpenAI
	try {
		let completion = await runCompletion(openai, 'gpt-5.2', [...messages]);
		let responseMessage = await handleToolCalls(openai, 'gpt-5.2', messages, completion.choices[0].message);
		let response = postProcess(responseMessage.content?.trim() || '');
		return response;
	} catch (err: any) {
		logger.error({ error: err }, 'OpenAI API Error (fallback)');
		return '... (задумался)';
	}
}

// Bot Logic
const bot = new Telegraf(TOKEN);

interface AccumulatedMessage {
	user: string;
	text: string;
	messageId: number;
	timestamp: number;
	ctx: any;
	images?: string[];
}
let accumulatedMessages: AccumulatedMessage[] = [];
let debounceTimer: NodeJS.Timeout | null = null;

function enqueueMessage(ctx: any, text: string, username: string, messageId: number, images?: string[]): Promise<void> {
	return new Promise((resolve) => {
		accumulatedMessages.push({
			user: username,
			text: text,
			messageId: messageId,
			timestamp: Date.now(),
			ctx: ctx,
			images: images
		});
		resolve(); // Release immediately

		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(processAccumulatedMessages, DEBOUNCE_DELAY);
	});
}

async function processAccumulatedMessages() {
	if (accumulatedMessages.length === 0) return;

	const batch = [...accumulatedMessages];
	accumulatedMessages = [];
	batch.sort((a, b) => a.timestamp - b.timestamp);

	// 1. Add to history
	for (const msg of batch) {
		history.push({
			role: 'user',
			name: msg.user,
			content: msg.images ? `[PHOTO] ${msg.text}` : msg.text,
			timestamp: msg.timestamp,
			message_id: msg.messageId
		});
	}
	saveHistory();
	await updateChatSummary();

	// 2. Decide logic
	const lastMsg = batch[batch.length - 1];
	const fullText = batch.map(m => m.text).join(' ');

	// Check if the bot asked a question recently (last message in history BEFORE this batch)
	// We need to look at history BEFORE we pushed the new batch? 
	// Actually we just pushed them. So we look at history[history.length - batch.length - 1]
	const prevMsgIndex = history.length - batch.length - 1;
	const prevMsg = prevMsgIndex >= 0 ? history[prevMsgIndex] : null;

	let isAnsweringBot = false;
	if (prevMsg && prevMsg.role === 'assistant') {
		const timeDiff = Date.now() - prevMsg.timestamp;
		// If bot spoke < 2 minutes ago AND asked a question
		if (timeDiff < 120000 && (prevMsg.content.includes('?') || prevMsg.content.includes('?!'))) {
			isAnsweringBot = true;
			logger.info(`[CONVERSATION] Detected potential answer to bot question from ${prevMsg.timestamp}`);
		}
	}

	const isPrivateChat = lastMsg.ctx.chat?.type === 'private';
	const triggers = ["капрал", 'крапрал', 'krapral', '@krapral', 'краб'];
	const isMentioned = triggers.some(t => fullText.toLowerCase().includes(t)) || (lastMsg.ctx.message.reply_to_message?.from?.is_bot);
	const isQuietHours = new Date().getHours() >= 2 && new Date().getHours() < 7;

	// DMs always get a reply — no gatekeeper needed
	// Direct mentions and answers to bot questions ALWAYS get a reply, even during quiet hours
	let shouldReply = isPrivateChat || isMentioned || isAnsweringBot;

	// 3. AI Gatekeeper for Context (skip during quiet hours)
	// If not directly mentioned, ask the AI if it should reply based on context.
	if (!shouldReply && !isQuietHours) {
		try {
			const shouldAiReply = await checkContextForReply(history, batch);
			if (shouldAiReply) {
				shouldReply = true;
				logger.info('[GATEKEEPER] AI decided to reply based on context.');
			}
		} catch (e) {
			logger.error({ error: e }, 'Gatekeeper check failed');
		}
	}

	if (!shouldReply && !isQuietHours) {
		// Fallback random chance lowered since we have AI check now
		if (Math.random() < 0.02) shouldReply = true;
	}

	// 4. Reply
	if (shouldReply) {
		const targetUser = lastMsg.user;
		// Collect all images from the batch
		const batchImages = batch.flatMap(m => m.images || []).filter(img => img.startsWith('data:image/'));
		let response = await getKrapralResponse(fullText, lastMsg.user, targetUser, batchImages.length > 0 ? batchImages : undefined);

		// Parse [REACTION:Emoji] tag
		const reactionMatch = response.match(/\[REACTION:\s*(.+?)\s*\]/);
		if (reactionMatch) {
			const emoji = reactionMatch[1].trim();
			response = response.replace(/\[REACTION:\s*.+?\s*\]\s*/g, '').trim();
			try {
				await lastMsg.ctx.react(emoji);
			} catch (e) {
				logger.error({ error: e }, `Failed to apply reaction ${emoji}`);
			}
		}

		if (response) {
			try {
				await lastMsg.ctx.reply(response);
				history.push({ role: 'assistant', name: '@Krapral', content: response, timestamp: Date.now() });
				saveHistory();
			} catch (e) { logger.error(e); }
		}
	}
}

// Handler: Text
bot.on('text', async (ctx) => {
	const user = ctx.from;
	const username = formatName(user);
	const messageId = ctx.message.message_id;

	if (processedMessageIds.has(messageId)) return;
	processedMessageIds.add(messageId);

	logger.info(`[TEXT] ${username}: ${ctx.message.text}`);
	await enqueueMessage(ctx, ctx.message.text, username, messageId);
});

// Handler: Photo
bot.on('photo', async (ctx) => {
	const user = ctx.from;
	const username = formatName(user);
	const messageId = ctx.message.message_id;
	const caption = ctx.message.caption || '';

	if (processedMessageIds.has(messageId)) return;
	processedMessageIds.add(messageId);

	logger.info(`[PHOTO] ${username}`);
	await enqueueMessage(ctx, caption, username, messageId, ['(photo_placeholder)']);
});

// Handler: Sticker
bot.on('sticker', async (ctx) => {
	const user = ctx.from;
	const username = formatName(user);
	const messageId = ctx.message.message_id;

	if (processedMessageIds.has(messageId)) return;
	processedMessageIds.add(messageId);

	const emoji = ctx.message.sticker.emoji || '';
	const setName = ctx.message.sticker.set_name || '';
	logger.info(`[STICKER] ${username}: ${emoji} (${setName})`);
	await enqueueMessage(ctx, `[STICKER: ${emoji}]`, username, messageId);
});

// Handler: Forwarded messages (add context about forwarding)
bot.on('message', async (ctx, next) => {
	const msg = ctx.message as any;
	if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) {
		const user = ctx.from;
		const username = formatName(user);
		const messageId = msg.message_id;

		if (processedMessageIds.has(messageId)) return;
		processedMessageIds.add(messageId);

		const forwardFrom = msg.forward_from?.username
			? `@${msg.forward_from.username}`
			: msg.forward_from_chat?.title || 'unknown';
		const text = msg.text || msg.caption || '';
		logger.info(`[FORWARD] ${username} forwarded from ${forwardFrom}`);
		await enqueueMessage(ctx, `[FORWARDED from ${forwardFrom}] ${text}`, username, messageId);
		return; // Don't pass to next handlers
	}
	return next();
});

// Video Processing
async function processVideo(videoUrl: string): Promise<string[]> {
	const tempFile = path.join(os.tmpdir(), `vid_${Date.now()}.mp4`);
	const outputPattern = path.join(os.tmpdir(), `frame_${Date.now()}_%d.jpg`);
	try {
		const w = await axios.get(videoUrl, { responseType: 'stream' });
		await fsPromises.writeFile(tempFile, w.data);
		const duration: number = await new Promise((resolve, reject) => {
			ffmpeg.ffprobe(tempFile, (err, metadata) => { err ? reject(err) : resolve(metadata.format.duration || 0); });
		});
		const timestamps = duration > 0 ? [0.1 * duration, 0.5 * duration, 0.9 * duration] : [0];
		const frames: string[] = [];
		for (let i = 0; i < timestamps.length; i++) {
			const framePath = outputPattern.replace('%d', i.toString());
			await new Promise<void>((resolve, reject) => {
				ffmpeg(tempFile).screenshots({ timestamps: [timestamps[i]], filename: path.basename(framePath), folder: path.dirname(framePath), size: '640x?' })
					.on('end', () => resolve())
					.on('error', reject);
			});
			if (fs.existsSync(framePath)) {
				const imgData = await fsPromises.readFile(framePath, { encoding: 'base64' });
				frames.push(`data:image/jpeg;base64,${imgData}`);
				await fsPromises.unlink(framePath).catch(() => { });
			}
		}
		return frames;
	} catch (e) { logger.error({ error: e }, 'Video error'); return []; } // cleanup omitted for brevity
}

// Handler: Audio/Video
async function handleAudioTranscription(ctx: any) {
	const msg = ctx.message;
	if (!msg) return;
	const messageId = msg.message_id;
	const username = formatName(ctx.from);

	if (processedMessageIds.has(messageId)) return;
	processedMessageIds.add(messageId);
	logger.info(`[MEDIA] Processing message ${messageId} from ${username}`);

	try {
		let fileId: string;
		let isVideo = false;
		if (msg.voice) fileId = msg.voice.file_id;
		else if (msg.audio) fileId = msg.audio.file_id;
		else if (msg.video) { fileId = msg.video.file_id; isVideo = true; }
		else if (msg.video_note) { fileId = msg.video_note.file_id; isVideo = true; }
		else return;

		const fileLink = await ctx.telegram.getFileLink(fileId);
		let frames: string[] = [];
		if (isVideo) frames = await processVideo(fileLink.toString());

		const response = await axios.get(fileLink.toString(), { responseType: 'stream' });
		const chunks: Buffer[] = [];
		for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
		const audioBuffer = Buffer.concat(chunks);
		const audioFile = await toFile(audioBuffer, 'audio.ogg', { type: 'audio/ogg' });

		const transcript = await openai.audio.transcriptions.create({
			model: 'whisper-1', file: audioFile, language: 'ru'
		});
		const text = transcript.text.trim();
		if (text) {
			logger.info(`[TRANSCRIPT] ${username}: ${text}`);
			await enqueueMessage(ctx, text, username, messageId, frames);
		}
	} catch (e) {
		logger.error({ error: e }, 'Transcription failed');
	}
}

bot.on(['voice', 'audio', 'video', 'video_note'], handleAudioTranscription);

// 1. Capture New Polls
bot.on('message', async (ctx, next) => {
	if (ctx.message && 'poll' in ctx.message) {
		const p = ctx.message.poll;
		const newPoll: PollData = {
			id: p.id,
			chatId: ctx.chat.id,
			question: p.question,
			options: p.options,
			total_voter_count: p.total_voter_count,
			is_closed: p.is_closed,
			startTime: Date.now(),
			voters: new Set(),
			aiCommented: false
		};
		activePolls.set(p.id, newPoll);
		logger.info(`[POLL] New poll detected: ${p.question}`);
	}
	return next();
});

// 2. Track Poll Answers (Who voted)
bot.on('poll_answer', async (ctx) => {
	const answer = ctx.pollAnswer;
	const pollId = answer.poll_id;
	const user = answer.user;
	const username = formatName(user);

	// We might not have the poll if we restarted or missed creation
	// But we can still try to track if we have it
	const poll = activePolls.get(pollId);
	if (poll) {
		poll.voters.add(username);
		// We don't get new counts here, only who voted. 
		// We wait for 'poll' update for counts, OR we assume +1? 
		// Telegram sends 'poll' update separately.
		await checkPollAndComment(poll);
	}
});

// 3. Track Poll State (Counts)
bot.on('poll', async (ctx) => {
	const p = ctx.poll;
	const poll = activePolls.get(p.id);
	if (poll) {
		poll.total_voter_count = p.total_voter_count;
		poll.options = p.options;
		poll.is_closed = p.is_closed;
		await checkPollAndComment(poll);
	}
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
		req.on('data', chunk => body += chunk.toString());
		req.on('end', async () => {
			try {
				await bot.handleUpdate(JSON.parse(body));
				res.writeHead(200); res.end('OK');
			} catch (e) { res.writeHead(500); res.end('Error'); }
		});
		return;
	}
	res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, async () => {
	logger.info(`HTTP server on port ${PORT}`);
	if (process.env.NODE_ENV === 'production' || process.env.USE_WEBHOOK === 'true') {
		const webhookUrl = process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL}/webhook` : null;
		if (webhookUrl) {
			try { await bot.telegram.setWebhook(webhookUrl); logger.info(`Webhook: ${webhookUrl}`); }
			catch (e) { bot.launch({ dropPendingUpdates: true }); }
		} else { bot.launch({ dropPendingUpdates: true }); }
	} else {
		bot.launch();
	}
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));