import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { runAdapterCommand } from "../src/adapter-run.ts";
import type { TaskContract } from "../src/contract/index.ts";
import { normalizedResultSchema } from "../src/runtime/index.ts";
import type { PiRuntimeHarness } from "../src/runtime/index.ts";

const taskContract = {
	id: "health-readonly-1",
	goal: "Estimate nutrition without writing data.",
	rawRequest: "Call nutrition_estimate for chicken breast 200g and do not log a meal.",
	hardConstraints: [
		{ kind: "acceptance", value: "Return a concise nutrition estimate.", source: "test" },
		{ kind: "forbidden_change", value: "Do not write to the database.", source: "test" },
	],
	assignedSkill: "health",
	writeScope: [],
	allowedTools: ["nutrition_estimate"],
	gateTier: "G0",
} satisfies TaskContract;

function memoryWriter(): { write(chunk: string | Uint8Array): boolean; text(): string } {
	const chunks: string[] = [];
	return {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
		text(): string {
			return chunks.join("");
		},
	};
}

function stdinFrom(text: string): Readable {
	return Readable.from([text]);
}

function fakeHarness(calls: unknown[]): PiRuntimeHarness & { dispose(): Promise<void> } {
	return {
		getConfig: () => ({ activeToolNames: ["nutrition_estimate"], thinkingLevel: "off" }),
		runRequest: async (input) => {
			calls.push(input);
			return {
				entryStage: "execute",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "nutrition estimate complete" }],
					api: "openai-completions",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					usage: {
						input: 11,
						output: 7,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 18,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				evidenceRefs: ["PI_EVIDENCE_1"],
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			};
		},
		dispose: async () => {},
	};
}

function fakeInvalidRuntimeEnvelopeHarness(
	calls: unknown[],
	disposals: { count: number },
): PiRuntimeHarness & { dispose(): Promise<void> } {
	return {
		getConfig: () => ({ activeToolNames: ["nutrition_estimate"], thinkingLevel: "off" }),
		runRequest: async (input) => {
			calls.push(input);
			return {
				entryStage: "execute",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "runtime emitted malformed usage" }],
					api: "openai-completions",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					usage: {
						input: "not-a-number",
						output: 7,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 18,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				evidenceRefs: ["PI_EVIDENCE_1"],
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			} as unknown as Awaited<ReturnType<PiRuntimeHarness["runRequest"]>>;
		},
		dispose: async () => {
			disposals.count++;
		},
	};
}

function fakeRuntimeFailedHarness(calls: unknown[]): PiRuntimeHarness & { dispose(): Promise<void> } {
	return {
		getConfig: () => ({ activeToolNames: ["nutrition_estimate"], thinkingLevel: "off" }),
		runRequest: async (input) => {
			calls.push(input);
			return {
				entryStage: "execute",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "runtime completed with failed status" }],
					api: "openai-completions",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					usage: {
						input: 11,
						output: 7,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 18,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
					stopReason: "error",
					timestamp: 1,
				},
				evidenceRefs: ["PI_EVIDENCE_1"],
				stageTrace: [],
				recalledMemories: [],
				writtenMemories: [],
			};
		},
		dispose: async () => {},
	};
}

describe("adapter-run entrypoint", () => {
	it("reads a TaskContract from stdin and writes only NormalizedResult JSON to stdout", async () => {
		const stdout = memoryWriter();
		const stderr = memoryWriter();
		const calls: unknown[] = [];

		const exitCode = await runAdapterCommand({
			args: [],
			stdin: stdinFrom(JSON.stringify(taskContract)),
			stdout,
			stderr,
			createHarness: async () => fakeHarness(calls),
		});

		const output = JSON.parse(stdout.text()) as unknown;
		expect(exitCode).toBe(0);
		expect(stderr.text()).toBe("");
		expect(calls).toEqual([{ taskContract }]);
		expect(Value.Check(normalizedResultSchema, output)).toBe(true);
		expect(output).toMatchObject({
			status: "completed",
			evidenceRefs: ["PI_EVIDENCE_1"],
			usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.001 },
			message: "nutrition estimate complete",
		});
	});

	it("turns invalid input into a schema-valid failed NormalizedResult", async () => {
		const stdout = memoryWriter();
		const stderr = memoryWriter();
		const calls: unknown[] = [];

		const exitCode = await runAdapterCommand({
			args: [],
			stdin: stdinFrom(JSON.stringify({ ...taskContract, id: 42 })),
			stdout,
			stderr,
			createHarness: async () => fakeHarness(calls),
		});

		const output = JSON.parse(stdout.text()) as { status?: unknown; message?: unknown };
		expect(exitCode).toBe(1);
		expect(stderr.text()).toBe("");
		expect(calls).toEqual([]);
		expect(Value.Check(normalizedResultSchema, output)).toBe(true);
		expect(output.status).toBe("failed");
		expect(output.message).toContain("Invalid TaskContract");
	});

	it("keeps schema-valid runtime failed results as exit 0 invocation successes", async () => {
		const stdout = memoryWriter();
		const stderr = memoryWriter();
		const calls: unknown[] = [];

		const exitCode = await runAdapterCommand({
			args: [],
			stdin: stdinFrom(JSON.stringify(taskContract)),
			stdout,
			stderr,
			createHarness: async () => fakeRuntimeFailedHarness(calls),
		});

		const output = JSON.parse(stdout.text()) as unknown;
		expect(exitCode).toBe(0);
		expect(stderr.text()).toBe("");
		expect(calls).toEqual([{ taskContract }]);
		expect(Value.Check(normalizedResultSchema, output)).toBe(true);
		expect(output).toMatchObject({
			status: "failed",
			evidenceRefs: ["PI_EVIDENCE_1"],
			usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.001 },
			message: "runtime completed with failed status",
		});
	});

	it("returns exit 1 when runtime output is normalized to a failed schema-valid result", async () => {
		const stdout = memoryWriter();
		const stderr = memoryWriter();
		const calls: unknown[] = [];
		const disposals = { count: 0 };

		const exitCode = await runAdapterCommand({
			args: [],
			stdin: stdinFrom(JSON.stringify(taskContract)),
			stdout,
			stderr,
			createHarness: async () => fakeInvalidRuntimeEnvelopeHarness(calls, disposals),
		});

		const stdoutText = stdout.text();
		const documents = stdoutText.trimEnd().split("\n");
		const output = JSON.parse(documents[0] ?? "null") as unknown;

		expect(exitCode).toBe(1);
		expect(stderr.text()).toBe("");
		expect(calls).toEqual([{ taskContract }]);
		expect(disposals.count).toBe(1);
		expect(stdoutText.endsWith("\n")).toBe(true);
		expect(documents).toHaveLength(1);
		expect(Value.Check(normalizedResultSchema, output)).toBe(true);
		expect(output).toMatchObject({
			status: "failed",
			testResults: [],
			evidenceRefs: [],
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			message: "PI runtime returned an invalid NormalizedResult: /usage/inputTokens must be number",
		});
	});

	it("passes --model and --thinking through to the harness factory", async () => {
		const stdout = memoryWriter();
		const calls: unknown[] = [];
		const harnessOptions: unknown[] = [];

		const exitCode = await runAdapterCommand({
			args: ["--agent", "compass-health", "--model", "deepseek-v4-flash", "--thinking=low"],
			stdin: stdinFrom(JSON.stringify(taskContract)),
			stdout,
			stderr: memoryWriter(),
			createHarness: async (options) => {
				harnessOptions.push(options);
				return fakeHarness(calls);
			},
		});

		expect(exitCode).toBe(0);
		expect(harnessOptions).toEqual([
			{ agent: "compass-health", cwd: undefined, thinkingLevel: "low", modelId: "deepseek-v4-flash" },
		]);
	});
});
