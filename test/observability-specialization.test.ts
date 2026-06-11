import { describe, expect, it } from "vitest";
import { parseCliArgs, resolveCliHarnessConfig } from "../src/cli/index.ts";
import { CostTracker } from "../src/observability/cost-tracker.ts";
import { formatSessionCost, formatTurnCost } from "../src/observability/formatter.ts";
import type { UsageSnapshot } from "../src/observability/types.ts";
import { createCodingSpecialization } from "../src/specializations/coding.ts";
import { createSpecializedHarness } from "../src/specializations/types.ts";

function usage(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	const cost = {
		input: overrides.cost?.input ?? 0,
		output: overrides.cost?.output ?? 0,
		cacheRead: overrides.cost?.cacheRead ?? 0,
		cacheWrite: overrides.cost?.cacheWrite ?? 0,
		total: overrides.cost?.total ?? 0,
	};
	return {
		input: overrides.input ?? 0,
		output: overrides.output ?? 0,
		cacheRead: overrides.cacheRead ?? 0,
		cacheWrite: overrides.cacheWrite ?? 0,
		totalTokens: overrides.totalTokens ?? 0,
		cost,
	};
}

describe("observability", () => {
	it("accumulates per-turn and session cost without mutating usage objects", () => {
		const tracker = new CostTracker();
		const firstUsage = usage({
			input: 70,
			output: 10,
			cacheRead: 30,
			cacheWrite: 20,
			totalTokens: 130,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		});
		const secondUsage = usage({
			input: 30,
			output: 5,
			totalTokens: 35,
			cost: { input: 0.002, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.005 },
		});

		tracker.handleEvent({ type: "turn_end", message: { role: "assistant", usage: firstUsage }, toolResults: [] });
		tracker.handleEvent({ type: "turn_end", message: { role: "assistant", usage: secondUsage }, toolResults: [] });
		firstUsage.cost.total = 99;

		expect(tracker.getTurns()).toHaveLength(2);
		expect(tracker.getTurns()[0]?.usage.cost.total).toBe(0.01);
		expect(tracker.getSummary()).toEqual({
			turnCount: 2,
			usage: {
				input: 100,
				output: 15,
				cacheRead: 30,
				cacheWrite: 20,
				totalTokens: 165,
				cost: { input: 0.003, output: 0.005, cacheRead: 0.003, cacheWrite: 0.004, total: 0.015 },
			},
			cacheHitRate: 0.2,
		});
	});

	it("returns zero cache hit rate when there are no input-side tokens", () => {
		const tracker = new CostTracker();

		tracker.handleEvent({ type: "turn_end", message: { role: "assistant", usage: usage() }, toolResults: [] });

		expect(tracker.getSummary().cacheHitRate).toBe(0);
	});

	it("formats costs deterministically", () => {
		const tracker = new CostTracker();
		tracker.handleEvent({
			type: "turn_end",
			message: {
				role: "assistant",
				usage: usage({
					input: 70,
					output: 10,
					cacheRead: 30,
					cacheWrite: 20,
					totalTokens: 130,
					cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
				}),
			},
			toolResults: [],
		});

		const firstTurn = tracker.getTurns()[0];
		expect(firstTurn).toBeDefined();
		if (!firstTurn) throw new Error("missing first turn");
		expect(formatTurnCost(firstTurn)).toBe(
			"turn 1: $0.010000 | tokens 70 in, 10 out, 30 cache read, 20 cache write | cache hit 25.0%",
		);
		expect(formatSessionCost(tracker.getSummary())).toBe(
			"session: 1 turn | $0.010000 | tokens 70 in, 10 out, 30 cache read, 20 cache write | cache hit 25.0%",
		);
	});
});

describe("specializations", () => {
	it("merges specialization config without mutating the base config", () => {
		const baseTool = { name: "base_tool" };
		const specTool = { name: "spec_tool" };
		const baseModel = { provider: "openai", id: "base-model" };
		const defaultModel = { provider: "anthropic", id: "default-model" };
		const baseConfig = {
			tools: [baseTool],
			systemPrompt: "base prompt",
			model: baseModel,
			thinkingLevel: "medium",
			policy: { allow: ["read"], deny: ["write"] },
		};

		const result = createSpecializedHarness(baseConfig, {
			name: "test",
			tools: [specTool],
			systemPrompt: "specialized prompt",
			defaultModel,
			defaultThinkingLevel: "high",
			policy: { deny: ["shell"] },
		});
		const withDefaults = createSpecializedHarness(
			{},
			{
				name: "defaults",
				defaultModel,
				defaultThinkingLevel: "high",
			},
		);

		expect(result.tools).toEqual([baseTool, specTool]);
		expect(result.systemPrompt).toBe("base prompt\n\nspecialized prompt");
		expect(result.model).toBe(baseModel);
		expect(result.thinkingLevel).toBe("medium");
		expect(result.policy).toEqual({ allow: ["read"], deny: ["shell"] });
		expect(baseConfig.tools).toEqual([baseTool]);
		expect(withDefaults.model).toBe(defaultModel);
		expect(withDefaults.thinkingLevel).toBe("high");
	});

	it("deep-merges nested specialization policy maps", () => {
		const result = createSpecializedHarness(
			{
				policy: {
					defaults: { "read-only": "allow", write: "ask" },
					tools: { read: "allow" },
				},
			},
			{
				name: "policy",
				policy: {
					defaults: { destructive: "deny" },
					tools: { shell: "deny" },
				},
			},
		);

		expect(result.policy).toEqual({
			defaults: { "read-only": "allow", write: "ask", destructive: "deny" },
			tools: { read: "allow", shell: "deny" },
		});
	});

	it("creates coding specialization from externally supplied tools", () => {
		const tool = { name: "edit" };
		const specialization = createCodingSpecialization({ tools: [tool] });

		expect(specialization.name).toBe("coding");
		expect(specialization.tools).toEqual([tool]);
		expect(specialization.systemPrompt).toContain("software engineering assistant");
	});
});

describe("CLI args", () => {
	it("parses simple options and trailing one-shot prompt", () => {
		expect(
			parseCliArgs([
				"--cwd",
				"G:\\work",
				"--provider=openai",
				"--model",
				"gpt-5",
				"--api-key",
				"secret",
				"hello",
				"world",
			]),
		).toEqual({
			options: { cwd: "G:\\work", provider: "openai", model: "gpt-5", apiKey: "secret" },
			prompt: "hello world",
			help: false,
		});
	});

	it("rejects empty resume ids and conflicting session flags", () => {
		expect(() => parseCliArgs(["--resume="])).toThrow("--resume requires a value");
		expect(() => parseCliArgs(["--resume", "abc", "--continue"])).toThrow(
			"--resume cannot be combined with --continue",
		);
	});

	it("maps CLI options to harness config and rejects unknown providers", () => {
		expect(resolveCliHarnessConfig({ cwd: "G:\\work", provider: "deepseek", model: "deepseek-v4-pro" })).toEqual({
			cwd: "G:\\work",
			provider: "deepseek",
			modelId: "deepseek-v4-pro",
			apiKey: undefined,
		});
		expect(() => resolveCliHarnessConfig({ provider: "missing-provider" })).toThrow(
			"unknown provider: missing-provider",
		);
	});
});
