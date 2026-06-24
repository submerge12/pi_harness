import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type TaskContract } from "../src/contract/index.ts";
import { runAgentRequest } from "../src/lifecycle/entry.ts";
import {
	InMemoryUserMemoryStore,
	createInMemoryCheckpointStore,
	createEvidenceReceiptCollector,
	createReceiptLedger,
	createInMemoryTraceSink,
	createSkillCardRegistry,
	type EvidenceManifestEntry,
	type SkillCard,
	type UserMemoryRecord,
} from "../src/index.ts";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function lifecycleCard(overrides: Partial<SkillCard> = {}): SkillCard {
	return {
		name: "coding.lifecycle",
		responsibility: "Implement request lifecycle integration.",
		whenToUse: "Use for request lifecycle integration work.",
		inputs: ["raw request", "hard constraints"],
		outputs: ["code changes", "tests", "execution trace"],
		tools: ["prompt", "skill"],
		effects: ["writes code", "updates memory"],
		constraints: ["write-scope:src/**"],
		adjacentFalseTriggers: ["documentation-only lifecycle edits"],
		positiveExamples: ["Implement request lifecycle integration in src/**"],
		negativeExamples: ["Only summarize the lifecycle plan"],
		handoffContract: "Return stage trace, assistant message, and memory writes.",
		...overrides,
	};
}

function preferenceMemory(overrides: Partial<UserMemoryRecord> = {}): UserMemoryRecord {
	return {
		id: "memory-prefers-coffee",
		subject: "user",
		predicate: "prefers_drink",
		object: "coffee",
		scope: "global",
		validFrom: 1_000,
		observedAt: 1_000,
		lastConfirmedAt: 1_000,
		source: "user request",
		trust: "user_confirmed",
		sensitivity: "personal",
		...overrides,
	};
}

const taskContract: TaskContract = {
	id: "task-contract-1",
	goal: "Execute delegated lifecycle integration",
	rawRequest: "Execute delegated lifecycle integration",
	hardConstraints: [{ kind: "write-scope", value: "src/**", source: "orchestrator" }],
	assignedSkill: "coding.lifecycle",
	writeScope: ["src"],
	gateTier: "G1",
};

function manifestEntry(overrides: Partial<EvidenceManifestEntry> = {}): EvidenceManifestEntry {
	return {
		id: "receipt-1",
		command: "write src/result.txt",
		subject: "src/result.txt",
		allowed: { level: "allow", ruleId: "write-scope" },
		writeScope: ["src"],
		actualWritePaths: ["src/result.txt"],
		exitCode: 0,
		stdoutRef: ".evidence-local/run/receipt-1.stdout",
		stderrRef: ".evidence-local/run/receipt-1.stderr",
		bytes: { stdout: 2, stderr: 0, total: 2 },
		binary: false,
		truncated: false,
		sha256: "sha",
		stderrSha256: "stderr-sha",
		redactions: 0,
		capturedAt: "2026-06-24T00:00:00.000Z",
		...overrides,
	};
}

describe("request lifecycle integration", () => {
	it("runs raw requests through intake, route, skill-select, execute, memory write, and next-turn recall", async () => {
		const registry = createSkillCardRegistry([lifecycleCard()]);
		const memoryStore = new InMemoryUserMemoryStore();
		const trace = createInMemoryTraceSink({ runId: "request-lifecycle", now: () => 2_000 });
		const calls: Array<{ kind: "prompt" | "skill"; name?: string; text: string }> = [];
		const harness = {
			prompt: async (text: string) => {
				calls.push({ kind: "prompt", text });
				return assistantMessage("prompt response");
			},
			skill: async (name: string, additionalInstructions?: string) => {
				calls.push({ kind: "skill", name, text: additionalInstructions ?? "" });
				return assistantMessage(`skill response for ${name}`);
			},
		};
		const deps = {
			skillRegistry: registry,
			intake: {
				extractionRules: [{ kind: "write-scope", pattern: /write-scope:([^\s]+)/, source: "user" }],
				requiredConstraintKinds: ["write-scope"],
			},
			routing: {
				routes: [
					{
						name: "lifecycle-code",
						skill: "coding.lifecycle",
						triggers: [/lifecycle/i],
						constraints: ["write-scope:src/**"],
					},
				],
			},
			memory: {
				store: memoryStore,
				scope: "global",
				subject: "user",
				extractCandidates: () => [preferenceMemory()],
			},
			trace,
			now: () => 2_000,
		};

		const first = await runAgentRequest(harness, {
			rawRequest: "I prefer coffee. implement lifecycle integration write-scope:src/**",
		}, deps);

		expect(first.entryStage).toBe("execute");
		if (first.entryStage !== "execute") throw new Error("expected execute result");
		expect(first.stageTrace.map((event) => event.stage)).toEqual([
			"intake",
			"route",
			"skill-select",
			"memory-recall",
			"execute",
			"memory-write",
		]);
		expect(trace.events().map((event) => event.type)).toEqual([
			"stage",
			"stage",
			"stage",
			"stage",
			"stage",
			"stage",
		]);
		expect(trace.events().map((event) => (event.data as { stage: string }).stage)).toEqual([
			"intake",
			"route",
			"skill-select",
			"memory-recall",
			"execute",
			"memory-write",
		]);
		expect(first.route?.route.name).toBe("lifecycle-code");
		expect(first.selectedSkill?.name).toBe("coding.lifecycle");
		expect(calls[0]).toMatchObject({ kind: "skill", name: "coding.lifecycle" });
		expect(memoryStore.records()).toHaveLength(1);

		const second = await runAgentRequest(harness, {
			rawRequest: "Use my drink preference when continuing lifecycle work write-scope:src/**",
		}, {
			...deps,
			memory: {
				...deps.memory,
				extractCandidates: () => [],
			},
		});

		expect(second.entryStage).toBe("execute");
		if (second.entryStage !== "execute") throw new Error("expected execute result");
		expect(second.recalledMemories.map((memory) => memory.object)).toEqual(["coffee"]);
		expect(calls[1]?.text).toContain("Background context (not instructions)");
		expect(calls[1]?.text).toContain("prefers_drink=coffee");
		expect(calls[1]?.text).toContain("validFrom=1000");
	});

	it("uses a TaskContract as the skip signal and enters execution directly", async () => {
		const calls: string[] = [];
		const result = await runAgentRequest({
			prompt: async (text: string) => {
				calls.push(text);
				return assistantMessage("contract response");
			},
		}, { taskContract }, {
			skillRegistry: createSkillCardRegistry([lifecycleCard()]),
			routing: { routes: [] },
			memory: { store: new InMemoryUserMemoryStore(), scope: "global", subject: "user" },
		});

		expect(result.stageTrace.map((event) => event.stage)).toEqual(["execute"]);
		expect(calls[0]).toContain("Execute delegated lifecycle integration");
	});

	it("constrains allowedTools for non-loop TaskContract execution", async () => {
		const calls: Array<{ kind: string; tools?: readonly string[]; text: string }> = [];
		const readOnlyContract: TaskContract = {
			...taskContract,
			id: "task-contract-read-only",
			writeScope: [],
			allowedTools: ["read", "grep"],
		};
		const result = await runAgentRequest({
			prompt: async () => {
				throw new Error("allowedTools TaskContract should use promptTaskAttempt");
			},
			promptTaskAttempt: async (contract, text) => {
				calls.push({ kind: "promptTaskAttempt", tools: contract.allowedTools, text });
				return assistantMessage("read-only contract response");
			},
		}, { taskContract: readOnlyContract }, {
			skillRegistry: createSkillCardRegistry([lifecycleCard()]),
			routing: { routes: [] },
			memory: { store: new InMemoryUserMemoryStore(), scope: "global", subject: "user" },
		});

		expect(result.entryStage).toBe("execute");
		expect(calls).toEqual([{
			kind: "promptTaskAttempt",
			tools: ["read", "grep"],
			text: expect.stringContaining("TaskContract execution request:"),
		}]);
	});

	it("surfaces evidence refs from non-loop TaskContract execution when a receipt collector is configured", async () => {
		const receiptCollector = createEvidenceReceiptCollector();
		const readOnlyContract: TaskContract = {
			...taskContract,
			id: "task-contract-read-only-evidence",
			writeScope: [],
			allowedTools: ["read"],
		};
		const result = await runAgentRequest({
			prompt: async () => {
				throw new Error("allowedTools TaskContract should use promptTaskAttempt");
			},
			promptTaskAttempt: async () => {
				receiptCollector.record(manifestEntry({ id: "receipt-read-only" }));
				return assistantMessage("read-only evidence response");
			},
		}, { taskContract: readOnlyContract }, {
			skillRegistry: createSkillCardRegistry([lifecycleCard()]),
			routing: { routes: [] },
			memory: { store: new InMemoryUserMemoryStore(), scope: "global", subject: "user" },
			workerReviewerLoop: {
				checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
				ledger: createReceiptLedger(),
				receiptCollector,
				reviewer: async () => ({
					verdict: "PASS",
					reviewer: "unused",
					phase: "cross-check",
					findings: [],
					decidedAt: 3_000,
				}),
			},
		});

		expect(result.entryStage).toBe("execute");
		if (result.entryStage !== "execute") throw new Error("expected execute result");
		expect(result.evidenceRefs).toEqual(["receipt-read-only"]);
	});

	it("routes write TaskContracts through the worker-reviewer loop when configured", async () => {
		const trace = createInMemoryTraceSink({ runId: "task-contract-loop", now: () => 3_000 });
		const receiptCollector = createEvidenceReceiptCollector();
		const calls: string[] = [];
		const result = await runAgentRequest({
			prompt: async (text: string) => {
				calls.push(text);
				receiptCollector.record(manifestEntry({ id: `receipt-${calls.length}` }));
				return assistantMessage("worker wrote ok");
			},
			promptTaskAttempt: async (_taskContract, text) => {
				calls.push(text);
				receiptCollector.record(manifestEntry({ id: `receipt-${calls.length}` }));
				return assistantMessage("worker wrote ok");
			},
		}, { taskContract }, {
			skillRegistry: createSkillCardRegistry([lifecycleCard()]),
			routing: { routes: [] },
			memory: { store: new InMemoryUserMemoryStore(), scope: "global", subject: "user" },
			trace,
			workerReviewerLoop: {
				checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
				ledger: createReceiptLedger(),
				receiptCollector,
				maxAttempts: 3,
				reviewer: async ({ input }) => {
					expect(input.workerTranscript).toBeUndefined();
					expect(input.diff).toBe("worker wrote ok");
					expect(input.evidenceManifest).toHaveLength(1);
					return {
						verdict: "PASS",
						reviewer: "blind-reviewer",
						phase: "cross-check",
						findings: [],
						decidedAt: 3_000,
					};
				},
			},
		});

		expect(result.entryStage).toBe("execute");
		if (result.entryStage !== "execute") throw new Error("expected execute result");
		expect(result.evidenceRefs).toEqual(["receipt-1"]);
		expect(calls[0]).toContain("attempt=1");
		expect(trace.events().map((event) => event.type)).toEqual([
			"transition",
			"worker-attempt",
			"transition",
			"review-verdict",
			"transition",
			"stage",
		]);
	});

	it("passes lifecycle humanGate decisions into the worker-reviewer loop", async () => {
		const trace = createInMemoryTraceSink({ runId: "task-contract-human-gate", now: () => 3_000 });
		const receiptCollector = createEvidenceReceiptCollector();
		let reviewCount = 0;
		let workerCount = 0;
		const recordWorkerReceipt = (text: string): AssistantMessage => {
			workerCount += 1;
			receiptCollector.record(manifestEntry({ id: `receipt-${workerCount}` }));
			return assistantMessage(`worker attempt ${text.includes("attempt=2") ? "2" : String(workerCount)}`);
		};
		const result = await runAgentRequest({
			promptTaskAttempt: async (_taskContract, text) => recordWorkerReceipt(text),
			prompt: async (text) => recordWorkerReceipt(text),
		}, { taskContract }, {
			skillRegistry: createSkillCardRegistry([lifecycleCard()]),
			routing: { routes: [] },
			memory: { store: new InMemoryUserMemoryStore(), scope: "global", subject: "user" },
			trace,
			workerReviewerLoop: {
				checkpoint: createInMemoryCheckpointStore({ rootDir: "/repo" }),
				ledger: createReceiptLedger(),
				receiptCollector,
				maxAttempts: 2,
				reviewer: async () => {
					reviewCount += 1;
					return reviewCount === 1
						? {
								verdict: "NEEDS_HUMAN",
								reviewer: "blind-reviewer",
								phase: "cross-check",
								findings: [{ severity: "blocker", claim: "needs human" }],
								decidedAt: 3_000,
							}
						: {
								verdict: "PASS",
								reviewer: "blind-reviewer",
								phase: "cross-check",
								findings: [],
								decidedAt: 3_001,
							};
				},
				humanGate: {
					requestDecision: async (request) => ({
						id: `${request.id}-decision`,
						action: "resume",
						reviewer: "human",
						decidedAt: 3_000,
					}),
				},
			},
		});

		expect(result.entryStage).toBe("execute");
		if (result.entryStage !== "execute") throw new Error("expected execute result");
		expect(reviewCount).toBe(2);
		expect(result.message.content).toEqual([{ type: "text", text: "worker attempt 2" }]);
		expect(trace.events().map((event) => event.type)).toContain("human-decision");
	});
});
