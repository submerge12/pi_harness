import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	createPiRuntimeAdapter,
	normalizedResultSchema,
	type WorkerAssignment,
} from "../../src/runtime/index.ts";

function assistantMessage(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 12,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 17,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

describe("createPiRuntimeAdapter", () => {
	it("reports capabilities from the configured PI harness", () => {
		const adapter = createPiRuntimeAdapter({
			getConfig: () => ({
				activeToolNames: ["read", "write", "bash"],
				contextWindow: 4096,
				thinkingLevel: "high",
			}),
			runRequest: async () => ({
				entryStage: "execute",
				message: assistantMessage("ok"),
				evidenceRefs: [],
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			}),
		});

		expect(adapter.id).toBe("pi");
		expect(adapter.capabilities()).toEqual({
			canEdit: true,
			canRunCommands: true,
			canNetwork: false,
			maxContextTokens: 4096,
			supportsThinking: true,
		});
	});

	it("runs a worker assignment through GenericHarness and returns a schema-valid NormalizedResult", async () => {
		const calls: unknown[] = [];
		const assignment: WorkerAssignment = {
			id: "assign-1",
			goal: "Write the result",
			rawRequest: "write result",
			assignedSkill: "coding",
			writeScope: ["src"],
			gateTier: "G1",
			allowedTools: ["read", "write"],
			hardConstraints: [{ kind: "acceptance", value: "result exists", source: "test" }],
		};
		const adapter = createPiRuntimeAdapter({
			getConfig: () => ({ activeToolNames: ["read", "write"], thinkingLevel: "off" }),
			runRequest: async (input) => {
				calls.push(input);
				return {
					entryStage: "execute",
					message: assistantMessage("worker complete"),
					evidenceRefs: [],
					stageTrace: [],
					recalledMemories: [],
					writtenMemories: [],
				};
			},
		});

		const result = await adapter.run(assignment);

		expect(calls).toEqual([{ taskContract: expect.objectContaining({ id: "assign-1", writeScope: ["src"] }) }]);
		expect(result).toEqual({
			status: "completed",
			testResults: [],
			evidenceRefs: [],
			usage: { inputTokens: 12, outputTokens: 5, costUsd: 0.003 },
			message: "worker complete",
		});
		expect(Value.Check(normalizedResultSchema, result)).toBe(true);
	});

	it("emits the executing ModelProfile id as the optional model field", async () => {
		const assignment: WorkerAssignment = {
			id: "assign-model",
			goal: "Write the result",
			rawRequest: "write result",
			assignedSkill: "coding",
			writeScope: ["src"],
			gateTier: "G1",
			hardConstraints: [{ kind: "acceptance", value: "result exists", source: "test" }],
		};
		const adapter = createPiRuntimeAdapter({
			getConfig: () => ({
				activeToolNames: ["read", "write"],
				thinkingLevel: "off",
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
			}),
			runRequest: async () => ({
				entryStage: "execute",
				message: assistantMessage("worker complete"),
				evidenceRefs: [],
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			}),
		});

		const result = await adapter.run(assignment);

		expect(result.model).toBe("deepseek-v4-pro@2026-06");
		expect(Value.Check(normalizedResultSchema, result)).toBe(true);
	});

	it("falls back to provider/modelId when no profile is registered for the model", async () => {
		const assignment: WorkerAssignment = {
			id: "assign-unprofiled",
			goal: "Write the result",
			rawRequest: "write result",
			assignedSkill: "coding",
			writeScope: ["src"],
			gateTier: "G1",
			hardConstraints: [{ kind: "acceptance", value: "result exists", source: "test" }],
		};
		const adapter = createPiRuntimeAdapter({
			getConfig: () => ({
				activeToolNames: ["read"],
				thinkingLevel: "off",
				provider: "openai",
				modelId: "gpt-x",
			}),
			runRequest: async () => ({
				entryStage: "execute",
				message: assistantMessage("worker complete"),
				evidenceRefs: [],
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			}),
		});

		const result = await adapter.run(assignment);

		expect(result.model).toBe("openai/gpt-x");
		expect(Value.Check(normalizedResultSchema, result)).toBe(true);
	});

	it("maps run evidence refs and failing review verdicts into the normalized result", async () => {
		const assignment: WorkerAssignment = {
			id: "assign-fail",
			goal: "Write the result",
			rawRequest: "write result",
			assignedSkill: "coding",
			writeScope: ["src"],
			gateTier: "G1",
			hardConstraints: [{ kind: "acceptance", value: "result exists", source: "test" }],
		};
		const adapter = createPiRuntimeAdapter({
			getConfig: () => ({ activeToolNames: ["read", "write"], thinkingLevel: "off" }),
			runRequest: async () => ({
				entryStage: "execute",
				message: assistantMessage("review failed"),
				evidenceRefs: ["receipt-1"],
				reviewVerdicts: [{
					verdict: "FAIL",
					reviewer: "blind-reviewer",
					phase: "cross-check",
					findings: [{ severity: "blocker", claim: "acceptance not met" }],
					decidedAt: 1,
				}],
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			}),
		});

		const result = await adapter.run(assignment);

		expect(result.status).toBe("failed");
		expect(result.evidenceRefs).toEqual(["receipt-1"]);
		expect(Value.Check(normalizedResultSchema, result)).toBe(true);
	});

	it("maps human-gated loop outcomes to blocked normalized results", async () => {
		const assignment: WorkerAssignment = {
			id: "assign-human",
			goal: "Write protected result",
			rawRequest: "write protected result",
			assignedSkill: "coding",
			writeScope: ["src"],
			gateTier: "G3",
			hardConstraints: [{ kind: "acceptance", value: "result exists", source: "test" }],
		};
		const adapter = createPiRuntimeAdapter({
			getConfig: () => ({ activeToolNames: ["read", "write"], thinkingLevel: "off" }),
			runRequest: async () => ({
				entryStage: "execute",
				message: assistantMessage("needs human"),
				evidenceRefs: [],
				loopState: "NEEDS_HUMAN",
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			}),
		});

		const result = await adapter.run(assignment);

		expect(result.status).toBe("blocked");
		expect(Value.Check(normalizedResultSchema, result)).toBe(true);
	});
});
