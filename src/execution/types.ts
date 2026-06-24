export type WriteScope = readonly string[];

export type ProcessKind = "harness" | "sandboxed-worker";

export interface ProcessRunnerOptions {
	cwd?: string;
	signal?: AbortSignal;
}

export interface ProcessRunner {
	run(command: string, args: readonly string[], options?: ProcessRunnerOptions): Promise<void>;
}

export interface ProcessGuard {
	assertHarnessProcess(): void;
}

export interface WorktreeLease {
	dir: string;
	writeScope: WriteScope;
	dispose(): Promise<void>;
}

export type ActiveWorktreeLease = Pick<WorktreeLease, "writeScope">;

export interface ActiveWorktreeLeaseProvider {
	getActiveLease(): ActiveWorktreeLease | undefined;
}

export interface WorktreeProvider {
	acquire(baselineSha: string, writeScope: WriteScope): Promise<WorktreeLease>;
}

export interface WriteScopeValidationOptions {
	allowEmpty?: boolean;
}
