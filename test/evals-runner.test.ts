import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runEvalTask } from "../evals/runner.ts";
import type { EvalExecutor, EvalTask } from "../evals/types.ts";

async function writeTask(task: EvalTask): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-eval-test-"));
	const taskPath = path.join(dir, "task.json");
	await writeFile(taskPath, JSON.stringify(task, null, 2), "utf8");
	return taskPath;
}

function baseTask(assertions: EvalTask["assertions"]): EvalTask {
	return {
		name: "coding/fix-failing-test",
		prompt: "Fix the failing test without network access.",
		fixture: {
			files: {
				"input.txt": "case-data",
			},
		},
		assertions,
	};
}

test("test_runEvalTask_matching_executor_passes", async () => {
	const taskPath = await writeTask(
		baseTask({
			files: [{ path: "result.txt", contains: "fixed case-data" }],
			outputMatch: "all good",
			forbiddenTools: ["delete_file"],
			allowedWriteRoots: ["outputs"],
			maxTurns: 3,
			maxUsd: 0.05,
		}),
	);
	const executor: EvalExecutor = async (context) => {
		const input = await readFile(path.join(context.workspacePath, "input.txt"), "utf8");
		await writeFile(path.join(context.workspacePath, "result.txt"), `fixed ${input}`, "utf8");
		return {
			output: "all good",
			toolCalls: [{ name: "write", input: { path: "outputs/result.txt" } }],
			turns: 2,
			costUsd: 0.01,
			cacheHitRate: 0.5,
		};
	};

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("passed");
	expect(result.failures).toEqual([]);
	expect(result.markdown).toContain("Status: pass");
	expect(result.markdown).toContain("Cost: $0.0100");
	expect(result.markdown).toContain("Cache hit rate: 50.00%");
});

test("test_runEvalTask_forbidden_tool_fails", async () => {
	const taskPath = await writeTask(baseTask({ forbiddenTools: ["delete_file"] }));
	const executor: EvalExecutor = async () => ({
		output: "done",
		toolCalls: [{ name: "delete_file" }],
		turns: 1,
		costUsd: 0,
	});

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("failed");
	expect(result.failures).toContain("forbidden tool used: delete_file");
	expect(result.markdown).toContain("Status: fail");
});

test("test_runEvalTask_output_mismatch_fails", async () => {
	const taskPath = await writeTask(baseTask({ outputMatch: "\\[[0-9]+\\]" }));
	const executor: EvalExecutor = async () => ({
		output: "citation missing",
		toolCalls: [],
		turns: 1,
		costUsd: 0,
	});

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("failed");
	expect(result.failures).toContain("output did not match pattern: \\[[0-9]+\\]");
});

test("test_runEvalTask_max_usd_exceeded_fails", async () => {
	const taskPath = await writeTask(baseTask({ maxUsd: 0.05 }));
	const executor: EvalExecutor = async () => ({
		output: "done",
		toolCalls: [],
		turns: 1,
		costUsd: 0.11,
	});

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("failed");
	expect(result.failures).toContain("cost $0.1100 exceeded maxUsd $0.0500");
});

test("test_runEvalTask_max_turns_exceeded_fails", async () => {
	const taskPath = await writeTask(baseTask({ maxTurns: 2 }));
	const executor: EvalExecutor = async () => ({
		output: "done",
		toolCalls: [],
		turns: 3,
		costUsd: 0,
	});

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("failed");
	expect(result.failures).toContain("turns 3 exceeded maxTurns 2");
});

test("test_runEvalTask_missing_metrics_fail_requested_limits", async () => {
	const taskPath = await writeTask(baseTask({ maxTurns: 3, maxUsd: 0.05 }));
	const executor: EvalExecutor = async () => ({
		output: "done",
		toolCalls: [],
	});

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("failed");
	expect(result.failures).toContain("turns metric missing for maxTurns assertion");
	expect(result.failures).toContain("costUsd metric missing for maxUsd assertion");
});

test("test_runEvalTask_write_path_outside_allowed_roots_fails", async () => {
	const taskPath = await writeTask(baseTask({ allowedWriteRoots: ["outputs"] }));
	const executor: EvalExecutor = async () => ({
		output: "done",
		toolCalls: [{ name: "write", input: { path: "summary.json" } }],
		turns: 1,
		costUsd: 0,
	});

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("failed");
	expect(result.failures).toContain("write path outside allowed roots: summary.json");
});

test("test_runEvalTask_fixture_path_copies_workspace", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-eval-fixture-"));
	const fixtureDir = path.join(root, "fixture");
	await mkdir(path.join(fixtureDir, "nested"), { recursive: true });
	await writeFile(path.join(fixtureDir, "nested", "source.txt"), "fixture-data", "utf8");
	const taskPath = path.join(root, "task.json");
	await writeFile(taskPath, JSON.stringify({
		name: "copy-fixture",
		prompt: "Read the fixture.",
		fixture: { path: "fixture" },
		assertions: { outputMatch: "fixture-data" },
	}, null, 2), "utf8");
	const executor: EvalExecutor = async (context) => {
		const input = await readFile(path.join(context.workspacePath, "nested", "source.txt"), "utf8");
		return {
			output: input,
			toolCalls: [],
			turns: 1,
			costUsd: 0,
		};
	};

	const result = await runEvalTask(taskPath, executor);

	expect(result.status).toBe("passed");
});

describe("eval task fixture validation", () => {
	test("test_runEvalTask_missing_fixture_file_fails", async () => {
		const taskPath = await writeTask(baseTask({ files: [{ path: "missing.txt", contains: "value" }] }));
		const executor: EvalExecutor = async () => ({
			output: "done",
			toolCalls: [],
			turns: 1,
			costUsd: 0,
		});

		const result = await runEvalTask(taskPath, executor);

		expect(result.status).toBe("failed");
		expect(result.failures).toContain("file missing: missing.txt");
	});

	test("test_runEvalTask_rejects_fixture_path_escape", async () => {
		const taskPath = await writeTask({
			name: "escape-fixture",
			prompt: "Read escaped fixture.",
			fixture: { path: ".." },
			assertions: {},
		});

		await expect(runEvalTask(taskPath, async () => ({ output: "" }))).rejects.toThrow("path escapes workspace");
	});

	test("test_runEvalTask_rejects_absolute_fixture_path", async () => {
		const taskPath = await writeTask({
			name: "absolute-fixture",
			prompt: "Read absolute fixture.",
			fixture: { path: tmpdir() },
			assertions: {},
		});

		await expect(runEvalTask(taskPath, async () => ({ output: "" }))).rejects.toThrow(
			"fixture path must be relative",
		);
	});
});
