import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHarnessProcessGuard, createWorktreeProvider } from "../../src/execution/index.ts";
import { resolveContainedWorktreeDir } from "../../src/execution/worktree-provider.ts";
import type { ProcessRunner } from "../../src/execution/types.ts";

interface RecordedCommand {
	command: string;
	args: readonly string[];
	cwd?: string;
}

function recordingRunner(commands: RecordedCommand[]): ProcessRunner {
	return {
		async run(command, args, options) {
			commands.push({ command, args: [...args], cwd: options?.cwd });
		},
	};
}

function deferred<T = void>(): { promise: Promise<T>; reject: (reason?: unknown) => void; resolve: (value: T) => void } {
	let reject!: (reason?: unknown) => void;
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

describe("createHarnessProcessGuard", () => {
	it("rejects worktree lifecycle from a sandboxed worker context", () => {
		const guard = createHarnessProcessGuard({ processKind: "sandboxed-worker" });

		expect(() => guard.assertHarnessProcess()).toThrow("git worktree lifecycle must run in the harness process");
	});
});

describe("createWorktreeProvider", () => {
	it("runs branch and worktree acquisition through the injected harness runner", async () => {
		const commands: RecordedCommand[] = [];
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: recordingRunner(commands),
			processKind: "harness",
			idGenerator: () => "worker-1",
		});

		const lease = await provider.acquire("abc123", ["src/execution"]);

		expect(lease).toMatchObject({
			dir: path.resolve("G:/repo/.worktrees", "worker-1"),
			writeScope: ["src/execution"],
		});
		expect(commands).toEqual([
			{ command: "git", args: ["branch", "pi-harness/worker-1", "abc123"], cwd: "G:/repo" },
			{
				command: "git",
				args: ["worktree", "add", path.resolve("G:/repo/.worktrees", "worker-1"), "pi-harness/worker-1"],
				cwd: "G:/repo",
			},
		]);
	});

	it("requires callers to provide explicit process placement intent", () => {
		const commands: RecordedCommand[] = [];

		expect(() =>
			// @ts-expect-error exercising runtime validation for untyped callers
			createWorktreeProvider({
				repoRoot: "G:/repo",
				worktreeRoot: "G:/repo/.worktrees",
				runner: recordingRunner(commands),
				idGenerator: () => "worker-implicit",
			}),
		).toThrow("worktree provider requires an explicit process guard or process kind");
		expect(commands).toEqual([]);
	});

	it("rejects worktree acquisition from an explicit sandboxed worker context", async () => {
		const commands: RecordedCommand[] = [];
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: recordingRunner(commands),
			processKind: "sandboxed-worker",
			idGenerator: () => "worker-sandboxed",
		});

		await expect(provider.acquire("abc123", ["src/execution"])).rejects.toThrow(
			"git worktree lifecycle must run in the harness process",
		);
		expect(commands).toEqual([]);
	});

	it("Phase 1.3 guard fires for the real sandboxed processKind before any git command", async () => {
		const commands: RecordedCommand[] = [];
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: recordingRunner(commands),
			processKind: "sandboxed-worker",
			idGenerator: () => "worker-real-sandbox",
		});

		await expect(provider.acquire("abc123", ["src/execution"])).rejects.toThrow(
			"git worktree lifecycle must run in the harness process",
		);
		expect(commands).toEqual([]);
	});

	it("rejects unsafe generated worktree ids before running git", async () => {
		for (const id of ["", ".", "..", "worker/1", "worker\\1", "worker:1"]) {
			const commands: RecordedCommand[] = [];
			const provider = createWorktreeProvider({
				repoRoot: "G:/repo",
				worktreeRoot: "G:/repo/.worktrees",
				runner: recordingRunner(commands),
				processKind: "harness",
				idGenerator: () => id,
			});

			await expect(provider.acquire("abc123", ["src/execution"])).rejects.toThrow("invalid worktree id");
			expect(commands).toEqual([]);
		}
	});

	it("rejects branch prefixes unsafe for generated branch refs before running git", async () => {
		for (const branchPrefix of [
			"",
			"pi harness",
			"pi/../harness",
			"pi//harness",
			".pi/harness",
			"pi.lock",
			"pi/harness.",
			"pi@{harness",
			"pi\\harness",
			"pi:harness",
		]) {
			const commands: RecordedCommand[] = [];
			const provider = createWorktreeProvider({
				repoRoot: "G:/repo",
				worktreeRoot: "G:/repo/.worktrees",
				runner: recordingRunner(commands),
				processKind: "harness",
				idGenerator: () => "worker-branch",
				branchPrefix,
			});

			await expect(provider.acquire("abc123", ["src/execution"])).rejects.toThrow("invalid branch prefix");
			expect(commands).toEqual([]);
		}
	});

	it("runs worktree disposal through the injected harness runner", async () => {
		const commands: RecordedCommand[] = [];
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: recordingRunner(commands),
			guard: createHarnessProcessGuard({ processKind: "harness" }),
			idGenerator: () => "worker-2",
		});
		const lease = await provider.acquire("def456", ["test/execution"]);

		await lease.dispose();

		expect(commands.at(-1)).toEqual({
			command: "git",
			args: ["worktree", "remove", path.resolve("G:/repo/.worktrees", "worker-2")],
			cwd: "G:/repo",
		});
	});

	it("retries disposal after a failed git worktree removal", async () => {
		const commands: RecordedCommand[] = [];
		let removeAttempts = 0;
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: {
				async run(command, args, options) {
					commands.push({ command, args: [...args], cwd: options?.cwd });
					if (args[0] === "worktree" && args[1] === "remove") {
						removeAttempts += 1;
						if (removeAttempts === 1) throw new Error("remove failed");
					}
				},
			},
			guard: createHarnessProcessGuard({ processKind: "harness" }),
			idGenerator: () => "worker-retry",
		});
		const lease = await provider.acquire("def456", ["test/execution"]);

		await expect(lease.dispose()).rejects.toThrow("remove failed");
		await expect(lease.dispose()).resolves.toBeUndefined();

		expect(commands.filter((command) => command.args[0] === "worktree" && command.args[1] === "remove")).toHaveLength(2);
	});

	it("shares one in-flight disposal attempt across concurrent dispose calls", async () => {
		const commands: RecordedCommand[] = [];
		const removeStarted = deferred();
		const releaseRemove = deferred();
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: {
				async run(command, args, options) {
					commands.push({ command, args: [...args], cwd: options?.cwd });
					if (args[0] === "worktree" && args[1] === "remove") {
						removeStarted.resolve();
						await releaseRemove.promise;
					}
				},
			},
			guard: createHarnessProcessGuard({ processKind: "harness" }),
			idGenerator: () => "worker-concurrent",
		});
		const lease = await provider.acquire("def456", ["test/execution"]);

		const firstDispose = lease.dispose();
		await removeStarted.promise;
		const secondDispose = lease.dispose();
		releaseRemove.resolve();

		await expect(Promise.all([firstDispose, secondDispose])).resolves.toEqual([undefined, undefined]);
		expect(commands.filter((command) => command.args[0] === "worktree" && command.args[1] === "remove")).toHaveLength(1);
	});

	it("cleans up the temporary branch when git worktree add fails", async () => {
		const commands: RecordedCommand[] = [];
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: {
				async run(command, args, options) {
					commands.push({ command, args: [...args], cwd: options?.cwd });
					if (args[0] === "worktree" && args[1] === "add") throw new Error("add failed");
				},
			},
			guard: createHarnessProcessGuard({ processKind: "harness" }),
			idGenerator: () => "worker-add-fails",
		});

		await expect(provider.acquire("def456", ["test/execution"])).rejects.toThrow("add failed");
		expect(commands).toEqual([
			{ command: "git", args: ["branch", "pi-harness/worker-add-fails", "def456"], cwd: "G:/repo" },
			{
				command: "git",
				args: ["worktree", "add", path.resolve("G:/repo/.worktrees", "worker-add-fails"), "pi-harness/worker-add-fails"],
				cwd: "G:/repo",
			},
			{ command: "git", args: ["branch", "-D", "pi-harness/worker-add-fails"], cwd: "G:/repo" },
		]);
	});

	it("does not call the runner after a sandboxed guard rejection", async () => {
		const commands: RecordedCommand[] = [];
		const provider = createWorktreeProvider({
			repoRoot: "G:/repo",
			worktreeRoot: "G:/repo/.worktrees",
			runner: recordingRunner(commands),
			guard: createHarnessProcessGuard({ processKind: "sandboxed-worker" }),
			idGenerator: () => "worker-3",
		});

		await expect(provider.acquire("abc123", ["src/execution"])).rejects.toThrow(
			"git worktree lifecycle must run in the harness process",
		);
		expect(commands).toEqual([]);
	});
});

describe("resolveContainedWorktreeDir", () => {
	const root = "G:/repo/.worktrees";

	it("returns a path directly under the worktree root for a safe id", () => {
		expect(resolveContainedWorktreeDir(root, "worker-1")).toBe(path.resolve(root, "worker-1"));
	});

	// S4 backstop: proven directly, independent of the S3 id validation that blocks these ids upstream.
	it("rejects ids that resolve to the root itself or escape it", () => {
		for (const id of [".", "..", "../sibling", "../../etc"]) {
			expect(() => resolveContainedWorktreeDir(root, id)).toThrow("worktree dir must stay under worktree root");
		}
	});
});
