import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProcessGuard, ProcessKind, ProcessRunner, WorktreeLease, WorktreeProvider, WriteScope } from "./types.ts";
import { validateWriteScope } from "./write-scope.ts";

export interface HarnessProcessGuardOptions {
	processKind: ProcessKind;
}

interface WorktreeProviderBaseOptions {
	repoRoot: string;
	worktreeRoot: string;
	runner: ProcessRunner;
	idGenerator?: () => string;
	branchPrefix?: string;
	allowEmptyWriteScope?: boolean;
}

export type WorktreeProviderOptions = WorktreeProviderBaseOptions &
	({ guard: ProcessGuard; processKind?: ProcessKind } | { guard?: ProcessGuard; processKind: ProcessKind });

export function createHarnessProcessGuard(options: HarnessProcessGuardOptions): ProcessGuard {
	return {
		assertHarnessProcess() {
			if (options.processKind !== "harness") {
				throw new Error("git worktree lifecycle must run in the harness process");
			}
		},
	};
}

export function createWorktreeProvider(options: WorktreeProviderOptions): WorktreeProvider {
	const guard = resolveProcessGuard(options);

	return {
		async acquire(baselineSha: string, writeScope: WriteScope): Promise<WorktreeLease> {
			const normalizedWriteScope = validateWriteScope(writeScope, { allowEmpty: options.allowEmptyWriteScope });
			guard.assertHarnessProcess();

			const id = validateWorktreeId(options.idGenerator?.() ?? randomUUID());
			const branchPrefix = validateBranchPrefix(options.branchPrefix ?? "pi-harness");
			const branchName = `${branchPrefix}/${id}`;
			const dir = resolveContainedWorktreeDir(options.worktreeRoot, id);

			await options.runner.run("git", ["branch", branchName, baselineSha], { cwd: options.repoRoot });
			try {
				await options.runner.run("git", ["worktree", "add", dir, branchName], { cwd: options.repoRoot });
			} catch (error) {
				try {
					await options.runner.run("git", ["branch", "-D", branchName], { cwd: options.repoRoot });
				} catch {
					// Preserve the worktree add failure; branch cleanup is best-effort.
				}
				throw error;
			}

			let disposed = false;
			let disposeAttempt: Promise<void> | undefined;
			return {
				dir,
				writeScope: normalizedWriteScope,
				async dispose() {
					if (disposed) return;
					if (disposeAttempt) return disposeAttempt;
					guard.assertHarnessProcess();
					disposeAttempt = options.runner
						.run("git", ["worktree", "remove", dir], { cwd: options.repoRoot })
						.then(
							() => {
								disposed = true;
							},
							(error) => {
								disposeAttempt = undefined;
								throw error;
							},
						);
					return disposeAttempt;
				},
			};
		},
	};
}

function resolveProcessGuard(options: WorktreeProviderOptions): ProcessGuard {
	if (options.guard) return options.guard;
	if (!("processKind" in options) || !options.processKind) {
		throw new Error("worktree provider requires an explicit process guard or process kind");
	}
	return createHarnessProcessGuard({ processKind: options.processKind });
}

function validateWorktreeId(id: string): string {
	if (!isSafeRefSegment(id) || id.includes("/") || id.includes("\\") || id.includes(":")) {
		throw new Error(`invalid worktree id: ${id}`);
	}
	return id;
}

function validateBranchPrefix(branchPrefix: string): string {
	if (branchPrefix.length === 0 || branchPrefix.startsWith("/") || branchPrefix.endsWith("/")) {
		throw new Error(`invalid branch prefix: ${branchPrefix}`);
	}
	if (!branchPrefix.split("/").every(isSafeRefSegment)) throw new Error(`invalid branch prefix: ${branchPrefix}`);
	return branchPrefix;
}

function isSafeRefSegment(segment: string): boolean {
	return (
		segment.length > 0 &&
		segment !== "." &&
		segment !== ".." &&
		segment !== "@" &&
		!segment.startsWith(".") &&
		!segment.startsWith("-") &&
		!segment.endsWith(".") &&
		!segment.endsWith(".lock") &&
		!segment.includes("..") &&
		!segment.includes("@{") &&
		!/[\s\x00-\x1f\x7f~^:?*[\]\\]/.test(segment)
	);
}

export function resolveContainedWorktreeDir(worktreeRoot: string, id: string): string {
	const root = path.resolve(worktreeRoot);
	const dir = path.resolve(root, id);
	const relative = path.relative(root, dir);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`worktree dir must stay under worktree root: ${dir}`);
	}
	return dir;
}
