import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { TaskContract } from "../contract/index.ts";
import type { AttemptDiff } from "../lifecycle/types.ts";
import { redactText } from "../redaction/core.ts";
import { truncateText } from "../tools/sandbox.ts";

export interface GitDiffSourceOptions {
	env: ExecutionEnv;
	cwd: string;
	maxChars?: number;
	timeoutSeconds?: number;
}

export function createGitDiffSource(options: GitDiffSourceOptions) {
	return async (input: { taskContract: TaskContract }): Promise<AttemptDiff | undefined> => {
		// No safe pathspec means git cannot describe the attempt; returning undefined lets
		// the lifecycle fall back to the worker self-report instead of a useless placeholder.
		if (normalizedPathspecs(input.taskContract.writeScope).length === 0) return undefined;
		return await readGitAttemptDiff(options, input.taskContract);
	};
}

export async function readGitAttemptDiff(
	options: GitDiffSourceOptions,
	taskContract: Pick<TaskContract, "writeScope">,
): Promise<AttemptDiff> {
	const pathspecs = normalizedPathspecs(taskContract.writeScope);
	if (pathspecs.length === 0) {
		return {
			diff: "Unable to read git diff: no safe filesystem write scope was available.",
			diffOrigin: "self-report",
		};
	}

	// quotePath=false keeps non-ASCII (e.g. CJK) filenames literal in diff headers.
	const tracked = await runGit(options, ["-c", "core.quotePath=false", "diff", "--", ...pathspecs]);
	if (!tracked.ok) return gitFailureDiff(tracked.message);
	const staged = await runGit(options, ["-c", "core.quotePath=false", "diff", "--cached", "--", ...pathspecs]);
	if (!staged.ok) return gitFailureDiff(staged.message);
	// -z gives NUL-separated, unquoted paths so filenames with spaces or CJK survive.
	const untracked = await runGit(options, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs]);
	if (!untracked.ok) return gitFailureDiff(untracked.message);
	const untrackedDiffs = await readUntrackedFileDiffs(options.env, untracked.stdout);
	const raw = [tracked.stdout, staged.stdout, ...untrackedDiffs].filter(Boolean).join("\n");
	const redacted = redactText(raw).text;
	return { diff: truncateText(redacted, options.maxChars).text, diffOrigin: "git" };
}

function gitFailureDiff(message: string): AttemptDiff {
	return {
		diff: truncateText(redactText(`Unable to read git diff: ${message}`).text).text,
		diffOrigin: "self-report",
	};
}

async function readUntrackedFileDiffs(env: ExecutionEnv, output: string): Promise<string[]> {
	const diffs: string[] = [];
	// NUL-separated -z output; filenames go to env.readTextFile, never a shell, so worker-
	// created names with spaces or CJK are reviewable — only traversal shapes are rejected.
	for (const filePath of output.split("\0").filter(Boolean)) {
		if (!isSafeUntrackedPath(filePath)) continue;
		const content = await env.readTextFile(filePath);
		if (!content.ok) continue;
		diffs.push(renderNewFileDiff(filePath, content.value));
	}
	return diffs;
}

function isSafeUntrackedPath(value: string): boolean {
	if (!value || value.includes("\0")) return false;
	if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
	if (hasControlCharacter(value)) return false;
	return !value.split("/").some((part) => part === "..");
}

function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function renderNewFileDiff(filePath: string, content: string): string {
	const lines = content.length === 0 ? [] : content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const displayLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
	return [
		`diff --git a/${filePath} b/${filePath}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${filePath}`,
		`@@ -0,0 +1,${displayLines.length} @@`,
		...displayLines.map((line) => `+${line}`),
	].join("\n");
}

async function runGit(
	options: GitDiffSourceOptions,
	args: readonly string[],
): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
	const command = ["git", ...args].join(" ");
	const result = await options.env.exec(command, {
		cwd: options.cwd,
		timeout: options.timeoutSeconds ?? 10,
	});
	if (!result.ok) return { ok: false, message: result.error.message };
	if (result.value.exitCode !== 0) {
		const message = result.value.stderr.trim() || `git exited with ${result.value.exitCode}`;
		return { ok: false, message };
	}
	return { ok: true, stdout: result.value.stdout };
}

function normalizedPathspecs(writeScope: readonly string[]): string[] {
	const specs: string[] = [];
	const seen = new Set<string>();
	for (const scope of writeScope) {
		const pathspec = normalizePathspec(scope);
		if (!pathspec || seen.has(pathspec)) continue;
		seen.add(pathspec);
		specs.push(pathspec);
	}
	return specs;
}

function normalizePathspec(scope: string): string | undefined {
	let value = scope.trim().replace(/\\/g, "/");
	if (!value || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return undefined;
	value = value.replace(/^\.\//, "");
	value = value.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
	if (value === "") return ".";
	return isSafeRelativePath(value) ? value : undefined;
}

function isSafeRelativePath(value: string): boolean {
	if (!value || value.includes("\0")) return false;
	if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
	if (!/^[A-Za-z0-9._/@+-]+$/.test(value)) return false;
	return !value.split("/").some((part) => part === "..");
}
