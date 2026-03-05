/**
 * Run all test scenarios and save results tagged with current git commit hash.
 *
 * Usage:
 *   npx ts-node --transpile-only test-scenarios/save-results.ts
 *
 * Results are saved to: test-scenarios/results/<commit-hash>.json
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import axios from 'axios';
import 'dotenv/config';

const GROK_KEY = process.env.GROK_API_KEY!;
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4-1-fast-non-reasoning';

if (!GROK_KEY) {
	console.error('ERROR: GROK_API_KEY not set');
	process.exit(1);
}

const grok = new OpenAI({ apiKey: GROK_KEY, baseURL: 'https://api.x.ai/v1' });

const RAW_IDENTITY = fs.readFileSync(path.join(process.cwd(), 'identity.txt'), 'utf-8');
const USERS_FILE = path.join(process.cwd(), 'users.json');
const USERS_JSON = fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, 'utf-8') : '{}';
const IDENTITY = RAW_IDENTITY.replace(/\[ВСТАВЬ СЮДА ВЕСЬ ТВОЙ JSON ИЗ ПЕРВОГО СООБЩЕНИЯ\]/, USERS_JSON);

// --- Replicated bot logic ---

function cleanBotPrefix(text: string): string {
	return text
		.replace(/^(@?[Кк]р[аa]пр[аa]л[:\s]*)+/i, '')
		.replace(/^@?[Kk]rapral[_]?(?:bot)?[:\s]*/i, '')
		.trim();
}

const TRIGGER_STRIP_PATTERN = /^[@]?(капрал|крапрал|krapral|краб|крабчик|крамар)[,;:!.\s]*/gi;
function stripTriggerWords(text: string): string {
	return text.replace(TRIGGER_STRIP_PATTERN, '').trim() || text;
}

function shouldSkipAsBriefOutburst(text: string): boolean {
	const lower = text.toLowerCase();
	const KRAPRAL_TRIGGERS = ["капрал", 'крапрал', 'krapral', '@krapral', 'краб', "крабчик", "крамар"];
	if (KRAPRAL_TRIGGERS.some(t => lower.includes(t))) return false;
	const words = text.trim().split(/\s+/);
	return words.length < 5 && !lower.includes('?');
}

const NEWS_KEYWORDS = /(новост|что происход|что случил|войн[аеуыоёй]|конфликт|обстрел|удар[аеи]|бомб|санкци|переговор|атак[аеуио]|наступлен|операци|фронт|ситуаци[яи]|что там с|что нового|последн|свеж|сегодня|сейчас|обстановк)/i;
const URL_PATTERN = /https?:\/\/[^\s<>\"']+/gi;

async function webSearch(query: string): Promise<string> {
	try {
		const resp = await axios.get('https://html.duckduckgo.com/html/', {
			params: { q: query, kl: 'ru-ru' },
			headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
			timeout: 5000
		});
		const matches = resp.data.match(/<a class="result__snippet"[^>]*>[\s\S]*?<\/a>/g);
		if (!matches || matches.length === 0) return '(no results found)';
		return matches.slice(0, 5).map((m: string, i: number) => {
			const text = m.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').trim();
			return `${i + 1}. ${text}`;
		}).join('\n');
	} catch { return '(search failed)'; }
}

async function fetchUrlContent(url: string): Promise<string> {
	try {
		const resp = await axios.get(url, {
			timeout: 5000, maxRedirects: 3,
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KrapralBot/1.0)' },
			responseType: 'text'
		});
		const html = typeof resp.data === 'string' ? resp.data : '';
		const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
		const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
		const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["'][^>]*>/i);
		const metaDesc = metaMatch ? metaMatch[1].trim() : '';
		const bodyMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i) || html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
		const bodyText = (bodyMatch ? bodyMatch[1] : html)
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
			.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1500);
		const parts = [];
		if (title) parts.push(`Title: ${title}`);
		if (metaDesc) parts.push(`Description: ${metaDesc}`);
		if (bodyText) parts.push(`Content: ${bodyText}`);
		return parts.join('\n') || '(could not extract content)';
	} catch (err: any) { return `(failed to load: ${err.message})`; }
}

async function getWebContext(text: string): Promise<string | null> {
	const urls = text.match(URL_PATTERN) || [];
	const shouldSearch = NEWS_KEYWORDS.test(text);
	if (!shouldSearch && urls.length === 0) return null;
	const parts: string[] = [];
	if (urls.length > 0) {
		const urlResults = await Promise.all(urls.slice(0, 3).map(async (url) => {
			const content = await fetchUrlContent(url);
			return `[Content from ${url}]:\n${content}`;
		}));
		parts.push(...urlResults);
	}
	if (shouldSearch) {
		const q = text.replace(URL_PATTERN, '').replace(/^[@]?(капрал|крапрал|krapral|краб|крабчик|крамар)[,;:!.\s]*/gi, '').trim();
		if (q.length > 3) parts.push(`[Web search results for "${q}"]:\n${await webSearch(q)}`);
	}
	return parts.length > 0 ? parts.join('\n\n') : null;
}

// --- Run scenario ---

interface ScenarioResult {
	scenario: string;
	description: string;
	incoming_text: string;
	incoming_user: string;
	should_reply: boolean;
	blocked_by_filter: boolean;
	web_context: string | null;
	raw_response: string | null;
	cleaned_response: string | null;
	checks: Record<string, boolean | string>;
}

async function runScenario(filePath: string): Promise<ScenarioResult> {
	const scenario = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	const name = path.basename(filePath, '.json');
	const incoming = scenario.incoming;
	const expected = scenario.expected_behavior;

	const result: ScenarioResult = {
		scenario: name,
		description: scenario.description,
		incoming_text: incoming.text,
		incoming_user: `${incoming.from.first_name} (@${incoming.from.username})`,
		should_reply: expected.should_reply !== false,
		blocked_by_filter: false,
		web_context: null,
		raw_response: null,
		cleaned_response: null,
		checks: {}
	};

	console.log(`  Running ${name}...`);

	// Check brief outburst filter
	if (expected.should_reply === false) {
		result.blocked_by_filter = shouldSkipAsBriefOutburst(incoming.text);
		result.checks['brief_outburst_blocked'] = result.blocked_by_filter;
		return result;
	}

	// Build messages
	const displayName = incoming.from.first_name;
	const username = `@${incoming.from.username}`;
	const displayLabel = displayName ? `[${displayName} (${username})]` : `[${username}]`;

	const webContext = await getWebContext(incoming.text);
	result.web_context = webContext ? webContext.substring(0, 500) : null;

	const userContent = `${displayLabel}: ${stripTriggerWords(incoming.text)}`;
	const enrichedContent = webContext
		? `${userContent}\n\n--- АКТУАЛЬНАЯ ИНФОРМАЦИЯ ИЗ ИНТЕРНЕТА (используй для ответа, но отвечай в своём стиле) ---\n${webContext}`
		: userContent;

	const messages: any[] = [
		{ role: 'system', content: IDENTITY },
		...(scenario.history || []).map((m: any) => ({
			role: m.role,
			name: m.name?.replace(/[^a-zA-Z0-9_-]/g, '_'),
			content: m.role === 'user' ? stripTriggerWords(m.content) : m.content
		})),
		{ role: 'user', name: username.replace(/[^a-zA-Z0-9_-]/g, '_'), content: enrichedContent }
	];

	// Prefix stripping unit tests
	if (scenario.simulated_raw_responses) {
		for (const raw of scenario.simulated_raw_responses) {
			const cleaned = cleanBotPrefix(raw);
			const passed = !cleaned.match(/^@?[Кк]р[аa]пр[аa]л/i) && !cleaned.match(/^@?[Kk]rapral/i);
			result.checks[`prefix_strip: "${raw}"`] = passed ? 'PASS' : 'FAIL';
		}
	}

	try {
		const completion = await grok.chat.completions.create({
			model: GROK_MODEL,
			messages,
			temperature: 1.2,
			max_tokens: 2000,
		});

		const raw = completion.choices[0]?.message?.content || '(empty)';
		const cleaned = cleanBotPrefix(raw);
		result.raw_response = raw;
		result.cleaned_response = cleaned;

		// Auto checks
		const hasPrefix = /^@?[Кк]р[аa]пр[аa]л/i.test(cleaned) || /^@?[Kk]rapral/i.test(cleaned);
		result.checks['no_self_prefix'] = !hasPrefix;

		if (expected.should_NOT_address) {
			result.checks[`not_addressing_${expected.should_NOT_address}`] = !cleaned.includes(expected.should_NOT_address);
		}
	} catch (err: any) {
		result.checks['api_error'] = err.message;
	}

	return result;
}

async function main() {
	// Get git info
	let commitHash: string;
	let commitMsg: string;
	let branch: string;
	try {
		commitHash = execSync('git rev-parse --short HEAD').toString().trim();
		commitMsg = execSync('git log -1 --pretty=%s').toString().trim();
		branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
	} catch {
		console.error('ERROR: Not a git repository or git not available');
		process.exit(1);
	}

	const isDirty = execSync('git status --porcelain').toString().trim().length > 0;
	const tag = isDirty ? `${commitHash}-dirty` : commitHash;

	console.log(`\nKrapral Test Results — ${tag} (${branch})`);
	console.log(`Commit: ${commitMsg}`);
	if (isDirty) console.log('WARNING: Working tree has uncommitted changes');
	console.log(`Model: ${GROK_MODEL}\n`);

	// Find and run scenarios
	const scenarioDir = path.join(process.cwd(), 'test-scenarios');
	const files = fs.readdirSync(scenarioDir)
		.filter(f => f.match(/^\d+-.+\.json$/))
		.sort();

	const results: ScenarioResult[] = [];
	for (const file of files) {
		const result = await runScenario(path.join(scenarioDir, file));
		results.push(result);
	}

	// Save results
	const resultsDir = path.join(scenarioDir, 'results');
	if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

	const output = {
		commit: commitHash,
		commit_message: commitMsg,
		branch,
		dirty: isDirty,
		model: GROK_MODEL,
		timestamp: new Date().toISOString(),
		scenarios: results
	};

	const outFile = path.join(resultsDir, `${tag}.json`);
	fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

	// Print summary
	console.log('\n═══════════════════════════════════════');
	console.log('  RESULTS SUMMARY');
	console.log('═══════════════════════════════════════\n');

	for (const r of results) {
		const status = r.blocked_by_filter
			? '🔇 BLOCKED'
			: r.cleaned_response
				? '💬 REPLIED'
				: '❌ ERROR';

		console.log(`${r.scenario}: ${status}`);
		if (r.cleaned_response) {
			console.log(`  → ${r.cleaned_response.substring(0, 120)}${r.cleaned_response.length > 120 ? '...' : ''}`);
		}
		if (r.web_context) {
			console.log(`  🌐 Web context used`);
		}

		const failedChecks = Object.entries(r.checks).filter(([, v]) => v === false || v === 'FAIL');
		if (failedChecks.length > 0) {
			for (const [check] of failedChecks) {
				console.log(`  ❌ FAIL: ${check}`);
			}
		}
		console.log('');
	}

	console.log(`Saved to: ${outFile}`);
}

main().catch(err => {
	console.error('Fatal error:', err);
	process.exit(1);
});
