import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	resetApiProviders,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgent,
	createPiRuntimeAdapter,
	type AgentProfile,
} from "../../src/index.ts";
import type { EvidenceManifestEntry } from "../../src/evidence/index.ts";
import type { TaskContract } from "../../src/contract/index.ts";
import { createJsonlSession } from "../../src/session/factory.ts";

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions" as const,
		provider: "deepseek" as const,
		model: "deepseek-v4-pro",
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

function attemptReceipt(attempt: number): EvidenceManifestEntry {
	return {
		id: `receipt-${attempt}`,
		command: "bash apply-change.sh",
		subject: "src/result.txt",
		allowed: { level: "allow", ruleId: "write-scope" },
		writeScope: ["src"],
		actualWritePaths: ["src/result.txt"],
		exitCode: 0,
		stdoutRef: `.evidence-local/run/receipt-${attempt}.stdout`,
		stderrRef: `.evidence-local/run/receipt-${attempt}.stderr`,
		bytes: { stdout: 2, stderr: 0, total: 2 },
		binary: false,
		truncated: false,
		sha256: "sha256",
		stderrSha256: "stderr-sha256",
		redactions: 0,
		capturedAt: "2026-07-06T00:00:00.000Z",
	};
}

function git(cwd: string, args: readonly string[]): void {
	execFileSync("git", [...args], { cwd, stdio: "ignore" });
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
	const raw = await readFile(path, "utf8");
	return raw
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function listFilesRecursively(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...await listFilesRecursively(path));
		else files.push(path);
	}
	return files;
}

afterEach(() => {
	resetApiProviders();
});

describe("repair-plan exit criteria (end-to-end)", () => {
	// PLAN-repair exit criterion 2: one FAIL → rewind → PASS run must report completed,
	// restore bash-written files between attempts, and cite a git diff, all through the
	// default createAgent wiring.
	// Real git + two spawned reviewer agents: needs headroom beyond the 5s default under full-suite load.
	it("repairs a failing attempt, restores bash writes, and completes with git-cited verdicts", { timeout: 30_000 }, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-exit-criterion-2-"));
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "src", "result.txt"), "before\n", "utf8");
		git(cwd, ["init"]);
		git(cwd, ["add", "src/result.txt"]);
		git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
		const { env, session } = await createJsonlSession({ cwd, sessionsRoot: ".sessions" });

		let workerAttempts = 0;
		let reviewerCalls = 0;
		const attemptTwoObserved: { content?: string; scratchExists?: boolean } = {};
		const profile: AgentProfile = {
			name: "repair-e2e",
			description: "exit-criterion-2 harness profile",
			systemPrompt: "Apply the requested change.",
			install: (harness) => {
				(harness as { prompt: typeof harness.prompt }).prompt = async (text) => {
					if (typeof text === "string" && text.startsWith("You are an adversarial blind reviewer.")) {
						reviewerCalls += 1;
						return assistantMessage(JSON.stringify({
							verdict: reviewerCalls === 1 ? "FAIL" : "PASS",
							reviewer: "e2e-reviewer",
							phase: "blind",
							findings: reviewerCalls === 1
								? [{ severity: "blocker", claim: "wrote bad content" }]
								: [],
						})) as Awaited<ReturnType<typeof harness.prompt>>;
					}
					workerAttempts += 1;
					if (workerAttempts === 2) {
						// The rewind must have restored the bash-written file and removed the
						// file created by the failed attempt before this attempt starts.
						attemptTwoObserved.content = readFileSync(join(cwd, "src", "result.txt"), "utf8");
						attemptTwoObserved.scratchExists = existsSync(join(cwd, "src", "scratch.txt"));
					}
					// Mutations outside the write/edit tools — the bash path.
					writeFileSync(join(cwd, "src", "result.txt"), workerAttempts === 1 ? "bad\n" : "good\n", "utf8");
					if (workerAttempts === 1) writeFileSync(join(cwd, "src", "scratch.txt"), "temp\n", "utf8");
					harness.getRequestLifecycleDeps().workerReviewerLoop?.receiptCollector?.record(attemptReceipt(workerAttempts));
					return assistantMessage(`PI_HARNESS_DONE\napplied change ${workerAttempts}`) as Awaited<ReturnType<typeof harness.prompt>>;
				};
			},
		};
		const harness = await createAgent(profile, {
			cwd,
			sessionsRoot: ".sessions",
			env,
			session,
			apiKey: "test-api-key",
			reviewLoop: { enabled: true, maxAttempts: 2 },
		});

		try {
			const contract: TaskContract = {
				id: "exit-criterion-2",
				goal: "Write good content into src/result.txt",
				rawRequest: "write good content",
				hardConstraints: [{ kind: "acceptance", value: "exit-zero", source: "test" }],
				assignedSkill: "coding",
				writeScope: ["src"],
				gateTier: "G1",
			};
			const result = await createPiRuntimeAdapter(harness).run(contract);

			expect(result.status).toBe("completed");
			expect(workerAttempts).toBe(2);
			expect(reviewerCalls).toBe(2);
			expect(attemptTwoObserved).toEqual({ content: "before\n", scratchExists: false });
			expect(readFileSync(join(cwd, "src", "result.txt"), "utf8")).toBe("good\n");
			expect(existsSync(join(cwd, "src", "scratch.txt"))).toBe(false);

			const metadata = await session.getMetadata();
			const trace = await readJsonl(join(cwd, ".sessions", metadata.id, "worker-reviewer-trace.jsonl"));
			const verdicts = trace
				.filter((event) => event.type === "review-verdict")
				.map((event) => (event.data as { verdict: { verdict: string; diffOrigin?: string } }).verdict);
			expect(verdicts.map((verdict) => verdict.verdict)).toEqual(["FAIL", "PASS"]);
			expect(verdicts.map((verdict) => verdict.diffOrigin)).toEqual(["git", "git"]);
			const firstAttempt = trace.find((event) => event.type === "worker-attempt");
			expect((firstAttempt?.data as { diff: string }).diff).toContain("+bad");
		} finally {
			await harness.dispose();
		}
	});

	// PLAN-repair exit criterion 1: a single run in which a tool output carries a seeded
	// secret must leave zero unmasked occurrences across events.jsonl, evidence files,
	// the worker-reviewer trace, and human-gate persistence.
	it("keeps a seeded secret out of every persisted artifact of one run", { timeout: 30_000 }, async () => {
		const SECRET = "sk-e2e-seeded-secret-123456789";
		const faux = registerFauxProvider({
			api: "openai-completions",
			provider: "deepseek",
			tokensPerSecond: 0,
			tokenSize: { min: 1000, max: 1000 },
			models: [{
				id: "deepseek-v4-pro",
				name: "DeepSeek V4 Pro",
				contextWindow: 128000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				input: ["text"],
			}],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("leak_env", {}, { id: "call-leak" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(`PI_HARNESS_DONE\nDEEPSEEK_API_KEY=${SECRET}\nbare ${SECRET}\ndone`),
		]);

		const cwd = await mkdtemp(join(tmpdir(), "pi-exit-criterion-1-"));
		const { env, session } = await createJsonlSession({ cwd, sessionsRoot: ".sessions" });
		const profile: AgentProfile = {
			name: "leaky-e2e",
			description: "exit-criterion-1 harness profile",
			systemPrompt: "Run the leak tool.",
			tools: [
				(context) => ({
					tool: {
						name: "leak_env",
						label: "Leak Env",
						description: "Prints environment values including secrets.",
						parameters: Type.Object({}),
						execute: async () => {
							const entry = await context.evidenceGateway?.captureOutput({
								id: "leak-receipt",
								command: "bash cat .env",
								subject: "src/leak.txt",
								allowed: { level: "allow", ruleId: "e2e" },
								writeScope: ["src"],
								actualWritePaths: ["src/leak.txt"],
								stdout: `DEEPSEEK_API_KEY=${SECRET}\nbare ${SECRET}\n`,
							});
							return {
								content: [{
									type: "text",
									text: `env dump: DEEPSEEK_API_KEY=${SECRET} bare ${SECRET} receipt:${entry?.id ?? "none"}`,
								}],
								details: {},
							};
						},
					},
					accessLevel: "read-only",
				}),
			],
			install: (harness) => {
				const original = harness.prompt.bind(harness);
				(harness as { prompt: typeof harness.prompt }).prompt = async (text, options) => {
					if (typeof text === "string" && text.startsWith("You are an adversarial blind reviewer.")) {
						return assistantMessage(JSON.stringify({
							verdict: "NEEDS_HUMAN",
							reviewer: "e2e-reviewer",
							phase: "blind",
							findings: [{ severity: "warn", claim: `worker output included ${SECRET}` }],
						})) as Awaited<ReturnType<typeof harness.prompt>>;
					}
					return original(text, options);
				};
			},
		};
		const harness = await createAgent(profile, {
			cwd,
			sessionsRoot: ".sessions",
			env,
			session,
			apiKey: SECRET,
			reviewLoop: { enabled: true, maxAttempts: 1 },
		});

		try {
			const result = await createPiRuntimeAdapter(harness).run({
				id: "exit-criterion-1",
				goal: "Dump environment for diagnostics",
				rawRequest: "dump the environment",
				hardConstraints: [{ kind: "acceptance", value: "exit-zero", source: "test" }],
				assignedSkill: "coding",
				writeScope: ["src"],
				gateTier: "G1",
			});
			expect(result.status).toBe("blocked");

			const metadata = await session.getMetadata();
			const sessionsDir = join(cwd, ".sessions");
			const files = await listFilesRecursively(sessionsDir);
			const eventsPath = files.find((file) => file.endsWith(`${metadata.id}.events.jsonl`));
			const tracePath = files.find((file) => file.endsWith("worker-reviewer-trace.jsonl"));
			const gatePath = files.find((file) => file.endsWith("pending-human-gate.json"));
			const manifestPath = files.find((file) => file.endsWith("manifest.jsonl"));
			expect(eventsPath).toBeDefined();
			expect(tracePath).toBeDefined();
			expect(gatePath).toBeDefined();
			expect(manifestPath).toBeDefined();

			// The raw session transcript is a documented unredacted surface — everything
			// else persisted by the run must be secret-free.
			const isTranscript = (file: string) =>
				file.endsWith(`${metadata.id}.jsonl`) && !file.endsWith(".events.jsonl");
			const sweep = files.filter((file) => !isTranscript(file));
			for (const file of sweep) {
				const content = await readFile(file, "utf8");
				expect(content, `unmasked secret in ${file}`).not.toContain(SECRET);
			}
			expect(await readFile(eventsPath!, "utf8")).toContain("[REDACTED]");
			expect(await readFile(gatePath!, "utf8")).toContain("[REDACTED]");
		} finally {
			await harness.dispose();
		}
	});
});
