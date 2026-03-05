/**
 * Test runner for Krapral bot scenarios.
 * Sends each scenario to Grok API and displays response vs expected behavior.
 *
 * Usage:
 *   npx ts-node --transpile-only test-scenarios/run-tests.ts [scenario-number]
 *
 * Examples:
 *   npx ts-node --transpile-only test-scenarios/run-tests.ts        # run all
 *   npx ts-node --transpile-only test-scenarios/run-tests.ts 3      # run only 03-*
 */
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import 'dotenv/config';

const GROK_KEY = process.env.GROK_API_KEY!;
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4-1-fast-non-reasoning';

if (!GROK_KEY) {
	console.error('ERROR: GROK_API_KEY not set. Use .env or .env.local');
	process.exit(1);
}

const grok = new OpenAI({ apiKey: GROK_KEY, baseURL: 'https://api.x.ai/v1' });

// Load identity (same logic as bot.ts)
const RAW_IDENTITY = fs.readFileSync(path.join(process.cwd(), 'identity.txt'), 'utf-8');
const USERS_FILE = path.join(process.cwd(), 'users.json');
const USERS_JSON = fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, 'utf-8') : '{}';
const IDENTITY = RAW_IDENTITY.replace(
	/\[ВСТАВЬ СЮДА ВЕСЬ ТВОЙ JSON ИЗ ПЕРВОГО СООБЩЕНИЯ\]/,
	USERS_JSON
);

// Replicate bot logic
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
	if (KRAPRAL_TRIGGERS.some(t => lower.includes(t))) return false; // direct ping always passes
	const words = text.trim().split(/\s+/);
	return words.length < 5 && !lower.includes('?');
}

// Colors for terminal
const C = {
	reset: '\x1b[0m',
	bright: '\x1b[1m',
	dim: '\x1b[2m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	red: '\x1b[31m',
	bg: '\x1b[44m',
};

async function runScenario(filePath: string) {
	const scenario = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
	const name = path.basename(filePath, '.json');

	console.log(`\n${C.bg}${C.bright} SCENARIO: ${name} ${C.reset}`);
	console.log(`${C.dim}${scenario.description}${C.reset}\n`);

	// Check shouldReply logic
	const incoming = scenario.incoming;
	const briefOutburst = shouldSkipAsBriefOutburst(incoming.text);
	const expected = scenario.expected_behavior;

	if (expected.should_reply === false) {
		console.log(`${C.yellow}Expected: should NOT reply${C.reset}`);
		console.log(`${C.cyan}Brief outburst filter: ${briefOutburst ? 'BLOCKED (correct)' : 'PASSED (would reply)'}${C.reset}`);
		if (briefOutburst) {
			console.log(`${C.green}PASS — message correctly filtered out${C.reset}`);
		} else {
			console.log(`${C.red}NOTE — filter did not block, but other rules (cooldown etc.) may still prevent reply${C.reset}`);
		}
		console.log(`${C.dim}─────────────────────────────────────────${C.reset}`);
		return;
	}

	// Build messages for Grok (same as bot.ts getKrapralStream)
	const displayName = incoming.from.first_name;
	const username = `@${incoming.from.username}`;
	const displayLabel = displayName ? `[${displayName} (${username})]` : `[${username}]`;

	const messages: any[] = [
		{ role: 'system', content: IDENTITY },
		...(scenario.history || []).map((m: any) => ({
			role: m.role,
			name: m.name?.replace(/[^a-zA-Z0-9_-]/g, '_'),
			content: m.role === 'user' ? stripTriggerWords(m.content) : m.content
		})),
		{
			role: 'user',
			name: username.replace(/[^a-zA-Z0-9_-]/g, '_'),
			content: `${displayLabel}: ${stripTriggerWords(incoming.text)}`
		}
	];

	// Show what we're sending
	console.log(`${C.magenta}Incoming:${C.reset} ${displayLabel}: "${incoming.text}"`);
	console.log(`${C.magenta}History:${C.reset} ${(scenario.history || []).length} messages`);

	// For prefix-stripping test, show unit test results
	if (scenario.simulated_raw_responses) {
		console.log(`\n${C.cyan}Prefix stripping unit tests:${C.reset}`);
		for (const raw of scenario.simulated_raw_responses) {
			const cleaned = cleanBotPrefix(raw);
			const passed = !cleaned.match(/^@?[Кк]р[аa]пр[аa]л/i) && !cleaned.match(/^@?[Kk]rapral/i);
			console.log(`  "${raw}" → "${cleaned}" ${passed ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}`);
		}
	}

	// Call Grok API
	console.log(`\n${C.cyan}Calling Grok (${GROK_MODEL})...${C.reset}`);
	try {
		const completion = await grok.chat.completions.create({
			model: GROK_MODEL,
			messages,
			temperature: 1.2,
			max_tokens: 2000,
		});

		const raw = completion.choices[0]?.message?.content || '(empty)';
		const cleaned = cleanBotPrefix(raw);

		console.log('');
		console.log(`${C.green}${C.bright}╔══════════════════════════════════════════════════════╗${C.reset}`);
		console.log(`${C.green}${C.bright}║  BOT REPLY:${C.reset}`);
		console.log(`${C.green}${C.bright}║${C.reset}  ${cleaned}`);
		if (raw !== cleaned) {
			console.log(`${C.green}${C.bright}║${C.reset}  ${C.dim}(raw: ${raw})${C.reset}`);
		}
		console.log(`${C.green}${C.bright}╚══════════════════════════════════════════════════════╝${C.reset}`);
		console.log('');

		// Automated checks
		console.log(`\n${C.yellow}Checks:${C.reset}`);

		// Check self-prefix
		const hasPrefix = /^@?[Кк]р[аa]пр[аa]л/i.test(cleaned) || /^@?[Kk]rapral/i.test(cleaned);
		console.log(`  Self-prefix stripped: ${hasPrefix ? C.red + 'FAIL' : C.green + 'PASS'}${C.reset}`);

		// Check wrong username
		if (expected.should_NOT_address) {
			const wrongAddr = cleaned.includes(expected.should_NOT_address);
			console.log(`  Not addressing ${expected.should_NOT_address}: ${wrongAddr ? C.red + 'FAIL' : C.green + 'PASS'}${C.reset}`);
		}

		// Check must_NOT_do
		if (expected.must_NOT_do) {
			for (const rule of expected.must_NOT_do) {
				console.log(`  ${C.dim}Must NOT: ${rule}${C.reset} — ${C.yellow}(manual check)${C.reset}`);
			}
		}

		// Show expected for manual review
		console.log(`\n${C.yellow}Expected behavior:${C.reset}`);
		for (const [key, val] of Object.entries(expected)) {
			if (key === 'must_NOT_do' || key === 'example_responses') continue;
			console.log(`  ${C.dim}${key}:${C.reset} ${typeof val === 'string' ? val : JSON.stringify(val)}`);
		}
	} catch (err: any) {
		console.log(`${C.red}API Error: ${err.message}${C.reset}`);
	}

	console.log(`${C.dim}─────────────────────────────────────────${C.reset}`);
}

async function main() {
	const filterNum = process.argv[2]; // optional: run only scenario N
	const scenarioDir = path.join(process.cwd(), 'test-scenarios');
	const files = fs.readdirSync(scenarioDir)
		.filter(f => f.match(/^\d+-.+\.json$/))
		.sort();

	if (files.length === 0) {
		console.error('No scenario files found!');
		process.exit(1);
	}

	const filtered = filterNum
		? files.filter(f => f.startsWith(filterNum.padStart(2, '0')))
		: files;

	console.log(`${C.bright}Krapral Bot Test Runner${C.reset}`);
	console.log(`${C.dim}Scenarios: ${filtered.length}/${files.length} | Model: ${GROK_MODEL}${C.reset}`);

	for (const file of filtered) {
		await runScenario(path.join(scenarioDir, file));
	}

	console.log(`\n${C.bright}Done!${C.reset}`);
}

main().catch(err => {
	console.error('Fatal error:', err);
	process.exit(1);
});
