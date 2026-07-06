import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { createGitDiffSource, readGitAttemptDiff } from "../../src/execution/index.ts";
import type { TaskContract } from "../../src/contract/index.ts";
import { clearKnownSecretsForTesting, registerKnownSecret } from "../../src/redaction/core.ts";

interface FakeGitOutput {
	diff?: string;
	cachedDiff?: string;
	untracked?: string;
	files?: Record<string, string>;
	fail?: boolean;
	commands?: string[];
}

function fakeEnv(output: string | FakeGitOutput): ExecutionEnv {
	const config = typeof output === "string" ? { diff: output } : output;
	const commands = config.commands ?? [];
	return {
		exec: async (command: string) => {
			commands.push(command);
			return {
				ok: !config.fail,
				value: command.includes("diff --cached")
					? { stdout: config.cachedDiff ?? "", stderr: "", exitCode: 0 }
					: command.includes("ls-files")
						? { stdout: config.untracked ?? "", stderr: "", exitCode: 0 }
						: { stdout: config.diff ?? "", stderr: "", exitCode: 0 },
				error: new Error("git failed"),
			};
		},
		readTextFile: async (path: string) => {
			if (config.files && path in config.files) return { ok: true, value: config.files[path] };
			return { ok: false, error: new Error("unused") };
		},
	} as unknown as ExecutionEnv;
}

afterEach(() => {
	clearKnownSecretsForTesting();
});

describe("readGitAttemptDiff", () => {
	it("redacts registered secrets from git diffs", async () => {
		registerKnownSecret("sk-test-diff-secret");

		const result = await readGitAttemptDiff({
			env: fakeEnv("diff --git a/src/result.txt b/src/result.txt\n+DEEPSEEK_API_KEY=sk-test-diff-secret\n"),
			cwd: "/repo",
		}, { writeScope: ["src"] });

		expect(result.diffOrigin).toBe("git");
		expect(result.diff).toContain("[REDACTED]");
		expect(result.diff).not.toContain("sk-test-diff-secret");
	});

	it("bounds large git diffs", async () => {
		const result = await readGitAttemptDiff({
			env: fakeEnv(`diff --git a/src/large.txt b/src/large.txt\n+${"x".repeat(200)}`),
			cwd: "/repo",
			maxChars: 40,
		}, { writeScope: ["src"] });

		expect(result.diffOrigin).toBe("git");
		expect(result.diff).toContain("[Output truncated to 40");
	});

	it("includes staged and untracked file diffs", async () => {
		const result = await readGitAttemptDiff({
			env: fakeEnv({
				diff: "diff --git a/src/unstaged.txt b/src/unstaged.txt\n+unstaged\n",
				cachedDiff: "diff --git a/src/staged.txt b/src/staged.txt\n+staged\n",
				untracked: "src/new.txt\0",
				files: { "src/new.txt": "new\n" },
			}),
			cwd: "/repo",
		}, { writeScope: ["src"] });

		expect(result.diff).toContain("+unstaged");
		expect(result.diff).toContain("+staged");
		expect(result.diff).toContain("src/new.txt");
		expect(result.diffOrigin).toBe("git");
	});

	it("includes untracked files with CJK and space-containing names", async () => {
		const commands: string[] = [];
		const result = await readGitAttemptDiff({
			env: fakeEnv({
				untracked: "src/汉字报告.txt\0src/my report.txt\0",
				files: {
					"src/汉字报告.txt": "中文内容\n",
					"src/my report.txt": "spaced content\n",
				},
				commands,
			}),
			cwd: "/repo",
		}, { writeScope: ["src"] });

		expect(result.diffOrigin).toBe("git");
		expect(result.diff).toContain("src/汉字报告.txt");
		expect(result.diff).toContain("+中文内容");
		expect(result.diff).toContain("src/my report.txt");
		expect(result.diff).toContain("+spaced content");
		// Untracked names never enter a command line; only the ls-files -z listing does.
		expect(commands.some((command) => command.includes("ls-files") && command.includes("-z"))).toBe(true);
		expect(commands.some((command) => command.includes("汉字报告"))).toBe(false);
	});

	it("still rejects traversal-shaped untracked paths", async () => {
		const result = await readGitAttemptDiff({
			env: fakeEnv({
				untracked: "../escape.txt\0src/ok.txt\0",
				files: { "../escape.txt": "outside\n", "src/ok.txt": "inside\n" },
			}),
			cwd: "/repo",
		}, { writeScope: ["src"] });

		expect(result.diff).not.toContain("outside");
		expect(result.diff).toContain("+inside");
	});

	it("does not stamp git origin when git commands fail", async () => {
		const result = await readGitAttemptDiff({
			env: fakeEnv({ fail: true }),
			cwd: "/repo",
		}, { writeScope: ["src"] });

		expect(result.diffOrigin).toBe("self-report");
		expect(result.diff).toContain("Unable to read git diff");
	});

	it("rejects unsafe write-scope pathspecs before invoking git", async () => {
		const commands: string[] = [];
		await readGitAttemptDiff({
			env: fakeEnv({ commands }),
			cwd: "/repo",
		}, { writeScope: ["src/unsafe'path"] });

		expect(commands).toEqual([]);
	});

	it("returns undefined from the wired source when no safe pathspec exists, preserving self-report fallback", async () => {
		const source = createGitDiffSource({ env: fakeEnv({}), cwd: "/repo" });
		const taskContract = {
			id: "task-1",
			goal: "goal",
			rawRequest: "request",
			hardConstraints: [],
			assignedSkill: "coding",
			writeScope: [],
			gateTier: "G1",
		} satisfies TaskContract;

		await expect(source({ taskContract })).resolves.toBeUndefined();
	});
});
