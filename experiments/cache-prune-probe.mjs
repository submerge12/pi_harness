#!/usr/bin/env node
// DeepSeek prefix-cache prune probe.
//
// Tests whether this workflow holds on the real API:
//   1. Append-only history -> cache hits grow turn over turn.
//   2. Locally prune an irrelevant middle chunk and submit the trimmed
//      history once ("trim submission") -> partial hit up to the prune
//      point, miss for everything after it (one-time re-prefill cost).
//   3. Subsequent turns on the pruned history -> high hit rate again,
//      proving the cache re-established on the new prefix.
//
// DeepSeek reports cache activity per response in usage:
//   prompt_cache_hit_tokens / prompt_cache_miss_tokens
// Cache granularity is 64-token blocks, so hits round down to a block
// boundary; expect "close to", not "exactly equal".
//
// Run (PowerShell):
//   $env:DEEPSEEK_API_KEY = "sk-..."
//   node experiments/cache-prune-probe.mjs
//
// Optional env: DEEPSEEK_MODEL (default deepseek-v4-pro; try
// deepseek-chat if your account doesn't serve v4-pro),
// DEEPSEEK_BASE_URL (default https://api.deepseek.com),
// CACHE_PRUNE_PROBE_EXTRAS (comma-separated: tail-vs-head,
// separate-vs-combined, delay-sensitivity, or all),
// CACHE_PRUNE_DELAY_SECONDS (comma-separated; default 60,300,900).
//
// Default approximate cost: 4 requests x ~2-3K prompt tokens, mostly
// cached after request 1 -> well under one cent. Extra probes add live
// requests: tail-vs-head adds ~8, separate-vs-combined adds ~9, and
// delay-sensitivity adds ~12 plus the configured waits. With extras=all
// expect ~33 total requests and about 21 minutes of default explicit waits.

const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const REQUEST_PAUSE_MS = 3000;
const DEFAULT_DELAY_SECONDS = [60, 300, 900];
const VALID_EXTRA_MODES = new Set([
	"tail-vs-head",
	"separate-vs-combined",
	"delay-sensitivity",
	"all",
]);

if (!API_KEY) {
	console.error("DEEPSEEK_API_KEY is not set.");
	process.exit(1);
}

const enabledExtras = parseExtras(process.env.CACHE_PRUNE_PROBE_EXTRAS ?? "");
const delaySeconds = hasExtra(enabledExtras, "delay-sensitivity")
	? parseDelaySeconds(process.env.CACHE_PRUNE_DELAY_SECONDS ?? "")
	: [];

// Unique nonce per run so this run's prefix never collides with a
// previous run's server-side cache entries.
const runNonce = Math.random().toString(36).slice(2, 10);

function makeSystemPrompt(scenario) {
	const scenarioSuffix = scenario ? `, scenario ${scenario}` : "";
	return (
		`You are a terse assistant in an automated caching experiment (run ${runNonce}${scenarioSuffix}). ` +
		`Reply to every question with the single word: OK`
	);
}

// Deterministic ~350-token filler documents. Each must comfortably
// exceed the 64-token cache block so pruning one is visible in usage.
function makeDoc(index) {
	const lines = [];
	lines.push(`DOCUMENT ${index} — synthetic reference material for cache experiments.`);
	for (let i = 1; i <= 14; i++) {
		lines.push(
			`Section ${index}.${i}: The migration window for cluster ${index} opens at step ${i * 7}, ` +
				`requires checkpoint ${index * 100 + i} to be flushed, and rolls back automatically if ` +
				`replica lag exceeds ${i * 3} seconds on shard group ${index}-${i}.`,
		);
	}
	return lines.join("\n");
}

function docPair(index) {
	return [
		{ role: "user", content: makeDoc(index) },
		{ role: "assistant", content: `Noted document ${index}. OK` },
	];
}

function parseExtras(rawValue) {
	const modes = new Set();
	for (const value of rawValue.split(",")) {
		const mode = value.trim().toLowerCase();
		if (!mode) {
			continue;
		}
		if (!VALID_EXTRA_MODES.has(mode)) {
			throw new Error(
				`Unknown CACHE_PRUNE_PROBE_EXTRAS value "${value}". ` +
					`Use one of: ${[...VALID_EXTRA_MODES].join(", ")}.`,
			);
		}
		modes.add(mode);
	}
	return modes;
}

function hasExtra(modes, mode) {
	return modes.has("all") || modes.has(mode);
}

function parseDelaySeconds(rawValue) {
	if (!rawValue.trim()) {
		return DEFAULT_DELAY_SECONDS;
	}
	return rawValue.split(",").map((value) => {
		const seconds = Number(value.trim());
		if (!Number.isFinite(seconds) || seconds <= 0) {
			throw new Error(`Invalid CACHE_PRUNE_DELAY_SECONDS value "${value}".`);
		}
		return seconds;
	});
}

function formatSeconds(seconds) {
	if (Number.isInteger(seconds) && seconds >= 60 && seconds % 60 === 0) {
		return `${seconds / 60}m`;
	}
	return `${seconds}s`;
}

function makeFullHistory(systemPrompt) {
	return [
		{ role: "system", content: systemPrompt },
		...docPair(1),
		...docPair(2),
		...docPair(3),
		...docPair(4),
	];
}

function makePrunedHistory(systemPrompt, pruneDocs, tailMessages) {
	const messages = [{ role: "system", content: systemPrompt }];
	for (const docIndex of [1, 2, 3, 4]) {
		if (!pruneDocs.has(docIndex)) {
			messages.push(...docPair(docIndex));
		}
	}
	messages.push(...tailMessages);
	return messages;
}

function makeQuestion(index) {
	return { role: "user", content: `Question ${index}: reply OK.` };
}

function makeAssistantTurn(row) {
	return { role: "assistant", content: row.reply || "OK" };
}

async function chat(messages, label) {
	const response = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${API_KEY}`,
		},
		body: JSON.stringify({
			model: MODEL,
			messages,
			max_tokens: 8,
			temperature: 0,
			stream: false,
		}),
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`${label}: HTTP ${response.status} — ${body.slice(0, 500)}`);
	}
	const json = await response.json();
	const usage = json.usage ?? {};
	const hit = usage.prompt_cache_hit_tokens ?? 0;
	const miss = usage.prompt_cache_miss_tokens ?? usage.prompt_tokens ?? 0;
	const total = usage.prompt_tokens ?? hit + miss;
	const reply = json.choices?.[0]?.message?.content ?? "";
	return { label, total, hit, miss, hitRate: total > 0 ? hit / total : 0, reply };
}

function report(row) {
	const pct = (row.hitRate * 100).toFixed(1).padStart(5);
	console.log(
		`${row.label.padEnd(34)} prompt=${String(row.total).padStart(5)}  ` +
			`hit=${String(row.hit).padStart(5)}  miss=${String(row.miss).padStart(5)}  hit%=${pct}`,
	);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function labelWithPrefix(prefix, label) {
	return prefix ? `${prefix} ${label}` : label;
}

async function pause(ms, label) {
	if (label) {
		console.log(label);
	}
	await sleep(ms);
}

async function warmFullHistory(fullHistory, labelPrefix) {
	const q1 = makeQuestion(1);
	const r1 = await chat([...fullHistory, q1], labelWithPrefix(labelPrefix, "R1 cold build (expect ~0% hit)"));
	report(r1);
	await pause(REQUEST_PAUSE_MS);

	const a1 = makeAssistantTurn(r1);
	const q2 = makeQuestion(2);
	const appendOnly = [...fullHistory, q1, a1, q2];
	const r2 = await chat(appendOnly, labelWithPrefix(labelPrefix, "R2 append-only (expect high hit)"));
	report(r2);
	await pause(REQUEST_PAUSE_MS);

	return { q1, a1, q2, a2: makeAssistantTurn(r2), r1, r2 };
}

async function submitTrim(systemPrompt, pruneDocs, warmState, label) {
	const q3 = makeQuestion(3);
	const prunedHistory = makePrunedHistory(systemPrompt, pruneDocs, [
		warmState.q1,
		warmState.a1,
		warmState.q2,
		warmState.a2,
		q3,
	]);
	const r3 = await chat(prunedHistory, label);
	report(r3);
	return { prunedHistory, q3, a3: makeAssistantTurn(r3), r3 };
}

async function submitPostTrim(prunedHistory, trimState, label) {
	const q4 = makeQuestion(4);
	const r4 = await chat([...prunedHistory, trimState.a3, q4], label);
	report(r4);
	return { q4, a4: makeAssistantTurn(r4), r4 };
}

async function runPruneScenario(config) {
	if (config.heading) {
		console.log(`\n=== ${config.heading} ===`);
	}
	const systemPrompt = makeSystemPrompt(config.scenario);
	const fullHistory = makeFullHistory(systemPrompt);
	const warmState = await warmFullHistory(fullHistory, config.labelPrefix ?? "");
	const trimState = await submitTrim(systemPrompt, new Set(config.pruneDocs), warmState, config.trimLabel);
	await pause(config.delayBeforePostTrimMs ?? REQUEST_PAUSE_MS, config.delayLabel ?? "");
	const postState = await submitPostTrim(trimState.prunedHistory, trimState, config.postTrimLabel);
	return { warmState, trimState, postState };
}

async function runTailVsHead() {
	console.log("\n=== tail-vs-head prune ===");
	await runPruneScenario({
		scenario: "head-prune-doc1",
		labelPrefix: "head",
		pruneDocs: [1],
		trimLabel: "H3 head trim DOC-1",
		postTrimLabel: "H4 post-head turn",
	});
	await runPruneScenario({
		scenario: "tail-prune-doc4",
		labelPrefix: "tail",
		pruneDocs: [4],
		trimLabel: "T3 tail trim DOC-4",
		postTrimLabel: "T4 post-tail turn",
	});
}

async function submitSecondSeparateTrim(systemPrompt, warmState, firstTrimState) {
	const q4 = makeQuestion(4);
	const prunedHistory = makePrunedHistory(systemPrompt, new Set([2, 3]), [
		warmState.q1,
		warmState.a1,
		warmState.q2,
		warmState.a2,
		firstTrimState.q3,
		firstTrimState.a3,
		q4,
	]);
	const r4 = await chat(prunedHistory, "S4 second trim DOC-3 (separate)");
	report(r4);
	return { prunedHistory, q4, a4: makeAssistantTurn(r4), r4 };
}

async function runSeparatePrunesScenario() {
	const systemPrompt = makeSystemPrompt("separate-doc2-doc3");
	const warmState = await warmFullHistory(makeFullHistory(systemPrompt), "separate");
	const firstTrimState = await submitTrim(
		systemPrompt,
		new Set([2]),
		warmState,
		"S3 first trim DOC-2 (separate)",
	);
	await pause(REQUEST_PAUSE_MS);

	const secondTrimState = await submitSecondSeparateTrim(systemPrompt, warmState, firstTrimState);
	await pause(REQUEST_PAUSE_MS);

	const q5 = makeQuestion(5);
	const r5 = await chat(
		[...secondTrimState.prunedHistory, secondTrimState.a4, q5],
		"S5 post-separate turn",
	);
	report(r5);
}

async function runSeparateVsCombined() {
	console.log("\n=== separate-vs-combined prune ===");
	await runSeparatePrunesScenario();
	await runPruneScenario({
		scenario: "combined-doc2-doc3",
		labelPrefix: "combined",
		pruneDocs: [2, 3],
		trimLabel: "C3 combined trim DOC-2+DOC-3",
		postTrimLabel: "C4 post-combined turn",
	});
}

async function runDelaySensitivity() {
	console.log("\n=== delay sensitivity ===");
	for (const seconds of delaySeconds) {
		const label = formatSeconds(seconds);
		await runPruneScenario({
			scenario: `delay-${label}`,
			labelPrefix: `delay-${label}`,
			pruneDocs: [2],
			trimLabel: `D3 trim before ${label} wait`,
			postTrimLabel: `D4 post-trim after ${label}`,
			delayBeforePostTrimMs: Math.round(seconds * 1000),
			delayLabel: `waiting ${label} before post-trim request...`,
		});
	}
}

function printInterpretation() {
	console.log("\nInterpretation:");
	console.log("  R1 hit ~0%        -> baseline; nothing cached for this run nonce.");
	console.log("  R2 hit high       -> append-only preserves the prefix; cache works.");
	console.log("  R3 hit small      -> pruning invalidated everything after the prune");
	console.log("                       point; hit covers only system+DOC-1. The miss");
	console.log("                       tokens are the one-time cost of the trim.");
	console.log("  R4 hit high again -> the pruned prefix is now cached; the workflow");
	console.log("                       (trim once, then keep hitting) is supported.");
	console.log("\nDecision rule for the harness: prune only when");
	console.log("  tokens_removed x expected_future_turns x full_price");
	console.log("    > tokens_after_prune_point x full_price   (the R3 re-prefill)");
	console.log("i.e. batch prunes (compaction-style), and prefer prune points as");
	console.log("late in the history as possible.");
	if (enabledExtras.size > 0) {
		console.log("\nExtra probes:");
		console.log("  tail-vs-head compares early vs late prune miss size.");
		console.log("  separate-vs-combined compares two re-prefills vs one batched re-prefill.");
		console.log("  delay-sensitivity measures whether the post-trim cache survives the wait.");
	}
}

// ---------------------------------------------------------------------------

console.log(`model=${MODEL}  base=${BASE_URL}  run=${runNonce}\n`);
if (enabledExtras.size > 0) {
	console.log(`extras=${[...enabledExtras].join(", ")}\n`);
}

await runPruneScenario({
	scenario: "",
	pruneDocs: [2],
	trimLabel: "R3 trim submission (partial hit)",
	postTrimLabel: "R4 post-trim turn (expect high hit)",
});

if (hasExtra(enabledExtras, "tail-vs-head")) {
	await runTailVsHead();
}

if (hasExtra(enabledExtras, "separate-vs-combined")) {
	await runSeparateVsCombined();
}

if (hasExtra(enabledExtras, "delay-sensitivity")) {
	await runDelaySensitivity();
}

// ---------------------------------------------------------------------------

printInterpretation();
