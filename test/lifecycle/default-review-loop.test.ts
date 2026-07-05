import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
	createAgent,
	createPiRuntimeAdapter,
	codingProfile,
	resolveHarnessConfig,
	type AgentProfile,
	type AgentToolFactoryContext,
} from "../../src/index.ts";
import type { EvidenceManifestEntry } from "../../src/evidence/index.ts";
import type { ReviewerInput } from "../../src/review/reviewer-agent.ts";
import { createJsonlSession } from "../../src/session/factory.ts";

function evidenceReceipt(overrides: Partial<EvidenceManifestEntry> = {}): EvidenceManifestEntry {
	return {
		id: "receipt-1",
		command: "node test/result.test.js",
		subject: "src/result.js",
		allowed: { level: "allow", ruleId: "eval" },
		writeScope: ["src"],
		actualWritePaths: ["src/result.js"],
		exitCode: 0,
		stdoutRef: ".evidence-local/run/receipt-1.stdout",
		stderrRef: ".evidence-local/run/receipt-1.stderr",
		bytes: { stdout: 2, stderr: 0, total: 2 },
		binary: false,
		truncated: false,
		sha256: "sha256",
		stderrSha256: "stderr-sha256",
		redactions: 0,
		capturedAt: "2026-06-24T00:00:00.000Z",
		...overrides,
	};
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions" as const,
		provider: "deepseek" as const,
		model: "test-model",
		usage: {
			input: 11,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 18,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop" as const,
		timestamp: 0,
	};
}

describe("default worker-reviewer loop boot", () => {
	it("constructs the loop from reviewLoop config instead of requiring injection", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-review-loop-default-"));
		const { env, session } = await createJsonlSession({ cwd, sessionsRoot: ".sessions" });
		const harness = await createAgent(codingProfile, {
			cwd,
			env,
			session,
			apiKey: "test-api-key",
			reviewLoop: { enabled: true, maxAttempts: 2, maxTurns: 4 },
		});

		try {
			const deps = harness.getRequestLifecycleDeps();
			expect(deps.workerReviewerLoop?.maxAttempts).toBe(2);
			expect(deps.workerReviewerLoop?.maxTurns).toBe(4);
			expect(deps.workerReviewerLoop?.receiptCollector).toBeDefined();
			expect(deps.trace).toBeDefined();
		} finally {
			await harness.dispose();
		}
	});

	it("creates a default evidence gateway for config-created review loops", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-review-loop-evidence-"));
		const observed: AgentToolFactoryContext[] = [];
		const profile: AgentProfile = {
			name: "observed",
			description: "observed profile",
			systemPrompt: "Observe runtime context.",
			tools: [
				(context) => {
					observed.push(context);
					return {
						tool: {
							name: "observe",
							label: "Observe",
							description: "Observe context",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						},
						accessLevel: "read-only",
					};
				},
			],
		};

		const harness = await createAgent(profile, {
			cwd,
			apiKey: "test-api-key",
			reviewLoop: { enabled: true },
		});

		try {
			expect(observed[0]?.evidenceGateway).toBeDefined();
		} finally {
			await harness.dispose();
		}
	});

	it("creates sanitized evidence refs for read-only adapter TaskContracts without tool receipts", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-review-loop-readonly-evidence-"));
		const rawRequestMarker = "raw request marker should not be persisted";
		const assistantTextMarker = "assistant text marker should not be persisted";
		const profile: AgentProfile = {
			name: "readonly-bridge",
			description: "readonly bridge profile",
			systemPrompt: "Answer the test request.",
			install: (harness) => {
				(harness as { prompt: typeof harness.prompt }).prompt = async () =>
					assistantMessage(assistantTextMarker) as Awaited<ReturnType<typeof harness.prompt>>;
			},
		};
		const harness = await createAgent(profile, {
			cwd,
			apiKey: "test-api-key",
			reviewLoop: { enabled: true, maxAttempts: 1, maxTurns: 3 },
		});

		try {
			const result = await createPiRuntimeAdapter(harness).run({
				id: "W20-A1",
				goal: "Return usage plus evidence references for a read-only domain-tool operation.",
				rawRequest: rawRequestMarker,
				hardConstraints: [{
					kind: "evidence",
					value: "Return a NormalizedResult with usage and evidenceRefs.",
					source: "test",
				}],
				assignedSkill: "health",
				writeScope: [],
				allowedTools: ["nutrition_estimate"],
				gateTier: "G0",
			});
			const session = harness.getSession();
			if (!session) throw new Error("expected session");
			const metadata = await session.getMetadata();
			const manifestPath = join(cwd, ".pi-harness", "sessions", metadata.id, "evidence", metadata.id, "manifest.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EvidenceManifestEntry[];
			const entry = manifest.find((item) => item.id === result.evidenceRefs[0]);
			if (!entry) throw new Error("expected evidence manifest entry");
			const stdout = await readFile(join(cwd, ".pi-harness", "sessions", metadata.id, entry.stdoutRef), "utf8");

			expect(result.status).toBe("completed");
			expect(result.usage.inputTokens).toBeGreaterThan(0);
			expect(result.evidenceRefs).toHaveLength(1);
			expect(entry.command).toBe("pi-harness task-contract attempt summary");
			expect(stdout).toContain("\"assignedSkill\":\"health\"");
			expect(stdout).toContain("\"allowedTools\":[\"nutrition_estimate\"]");
			expect(stdout).not.toContain(rawRequestMarker);
			expect(stdout).not.toContain(assistantTextMarker);
		} finally {
			await harness.dispose();
		}
	});

	it("spawns the default reviewer from an unregistered parent profile object", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-review-loop-object-profile-"));
		let spawnedReviewerPrompts = 0;
		const profile: AgentProfile = {
			name: "local-coding",
			description: "local coding profile object",
			systemPrompt: "Review locally.",
			install: (harness) => {
				(harness as { prompt: typeof harness.prompt }).prompt = async () => {
					spawnedReviewerPrompts += 1;
					return {
						role: "assistant",
						content: [{
							type: "text",
							text: JSON.stringify({
								verdict: "PASS",
								reviewer: "local-object-reviewer",
								phase: "blind",
								findings: [],
							}),
						}],
						api: "openai-completions",
						provider: "deepseek",
						model: "test-reviewer",
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
					} as Awaited<ReturnType<typeof harness.prompt>>;
				};
			},
		};
		const harness = await createAgent(profile, {
			cwd,
			apiKey: "test-api-key",
			reviewLoop: { enabled: true },
		});

		try {
			const loop = harness.getRequestLifecycleDeps().workerReviewerLoop;
			expect(loop).toBeDefined();
			const input: ReviewerInput = {
				diff: "ok",
				evidenceManifest: [evidenceReceipt()],
				acceptanceCriteria: [],
				policy: {},
			};
			const verdict = await loop?.reviewer({ attempt: 1, input, receipts: input.evidenceManifest });
			expect(spawnedReviewerPrompts).toBe(1);
			expect(verdict?.verdict).toBe("PASS");
			expect(verdict?.reviewer).toBe("local-object-reviewer");
		} finally {
			await harness.dispose();
		}
	});

	it("throws for an explicit unknown reviewer profile instead of falling back to the parent", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-review-loop-unknown-reviewer-"));
		const profile: AgentProfile = {
			name: "local-coding",
			description: "local coding profile object",
			systemPrompt: "Review locally.",
		};
		const harness = await createAgent(profile, {
			cwd,
			apiKey: "test-api-key",
			reviewLoop: { enabled: true, reviewerProfile: "missing-reviewer" },
		});

		try {
			const loop = harness.getRequestLifecycleDeps().workerReviewerLoop;
			const input: ReviewerInput = {
				diff: "ok",
				evidenceManifest: [evidenceReceipt()],
				acceptanceCriteria: [],
				policy: {},
			};
			await expect(loop?.reviewer({ attempt: 1, input, receipts: input.evidenceManifest })).rejects.toThrow(
				"Unknown agent profile: missing-reviewer",
			);
		} finally {
			await harness.dispose();
		}
	});

	it("maps RunPolicy repair limits into the created loop", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-review-loop-policy-"));
		const harness = await createAgent(codingProfile, {
			cwd,
			apiKey: "test-api-key",
			reviewLoop: {
				enabled: true,
				runPolicy: {
					budget: { maxTurns: 5, maxUsd: 1 },
					repairLimits: { maxAttempts: 2 },
					gateTiers: { G3: "human" },
				},
			},
		});

		try {
			const loop = harness.getRequestLifecycleDeps().workerReviewerLoop;
			expect(loop?.maxAttempts).toBe(2);
			expect(loop?.maxTurns).toBe(5);
			expect(loop?.budget).toBeDefined();
			expect(harness.getConfig().budget?.maxUsdPerSession).toBe(1);
			expect(loop?.runPolicy?.gateTiers?.G3).toBe("human");
			expect(loop?.humanGate).toBeDefined();
		} finally {
			await harness.dispose();
		}
	});

	it("resolves permission profiles into live policy and command rules", () => {
		const config = resolveHarnessConfig({ permissionProfile: "read-only" });

		expect(config.policy.defaults.write).toBe("deny");
		expect(config.commandRules?.some((rule) => rule.id === "deny-bulk-delete")).toBe(true);
	});
});
