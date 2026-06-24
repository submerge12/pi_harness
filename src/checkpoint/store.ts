import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { normalizeWriteScopePath } from "../execution/index.ts";
import { resolveWritableWithinRoots, sandboxRoots } from "../tools/sandbox.ts";
import type { CheckpointStore, CheckpointStoreOptions } from "./types.ts";

interface Snapshot {
	path: string;
	existed: boolean;
	content?: string;
}

export function createInMemoryCheckpointStore(options: CheckpointStoreOptions): CheckpointStore {
	const files = new Map<string, string>();
	const snapshotsByAttempt = new Map<number, Snapshot[]>();
	let activeAttempt: number | undefined;
	for (const [path, content] of initialEntries(options.files)) {
		files.set(safePath(path), content);
	}

	return {
		beginAttempt(attempt: number): void {
			assertValidAttempt(attempt);
			activeAttempt = attempt;
		},
		finishAttempt(): void {
			activeAttempt = undefined;
		},
		snapshot(attempt: number, path: string): void {
			assertValidAttempt(attempt);
			const normalizedPath = safePath(path);
			const snapshots = snapshotsByAttempt.get(attempt) ?? [];
			if (snapshots.some((snapshot) => snapshot.path === normalizedPath)) return;
			snapshots.push({
				path: normalizedPath,
				existed: files.has(normalizedPath),
				...(files.has(normalizedPath) ? { content: files.get(normalizedPath) } : {}),
			});
			snapshotsByAttempt.set(attempt, snapshots);
		},
		snapshotCurrent(path: string): void {
			if (activeAttempt === undefined) return;
			this.snapshot(activeAttempt, path);
		},
		restore(fromAttempt: number): void {
			assertValidAttempt(fromAttempt);
			const snapshots = snapshotsByAttempt.get(fromAttempt) ?? [];
			for (const snapshot of [...snapshots].reverse()) {
				if (snapshot.existed) {
					files.set(snapshot.path, snapshot.content ?? "");
				} else {
					files.delete(snapshot.path);
				}
			}
		},
		readFile(path: string): string | undefined {
			return files.get(safePath(path));
		},
		writeFile(path: string, content: string): void {
			files.set(safePath(path), content);
		},
		deleteFile(path: string): void {
			files.delete(safePath(path));
		},
	};
}

export interface ExecutionEnvCheckpointStoreOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
}

export function createExecutionEnvCheckpointStore(options: ExecutionEnvCheckpointStoreOptions): CheckpointStore {
	const snapshotsByAttempt = new Map<number, Snapshot[]>();
	let activeAttempt: number | undefined;
	const roots = sandboxRoots(options.env.cwd, options.roots);

	return {
		beginAttempt(attempt: number): void {
			assertValidAttempt(attempt);
			activeAttempt = attempt;
		},
		finishAttempt(): void {
			activeAttempt = undefined;
		},
		async snapshot(attempt: number, path: string): Promise<void> {
			assertValidAttempt(attempt);
			const normalizedPath = safePath(path);
			const resolvedPath = await resolveWritableWithinRoots(options.env, roots, normalizedPath);
			const snapshots = snapshotsByAttempt.get(attempt) ?? [];
			if (snapshots.some((snapshot) => snapshot.path === normalizedPath)) return;
			const readResult = await options.env.readTextFile(resolvedPath);
			if (readResult.ok) {
				snapshots.push({ path: normalizedPath, existed: true, content: readResult.value });
			} else if (isNotFound(readResult.error)) {
				snapshots.push({ path: normalizedPath, existed: false });
			} else {
				throw new Error(`Failed to snapshot ${normalizedPath}: ${readResult.error.message}`);
			}
			snapshotsByAttempt.set(attempt, snapshots);
		},
		async snapshotCurrent(path: string): Promise<void> {
			if (activeAttempt === undefined) return;
			await this.snapshot(activeAttempt, path);
		},
		async restore(fromAttempt: number): Promise<void> {
			assertValidAttempt(fromAttempt);
			const snapshots = snapshotsByAttempt.get(fromAttempt) ?? [];
			for (const snapshot of [...snapshots].reverse()) {
				const resolvedPath = await resolveWritableWithinRoots(options.env, roots, snapshot.path);
				const result = snapshot.existed
					? await options.env.writeFile(resolvedPath, snapshot.content ?? "")
					: await options.env.remove(resolvedPath);
				if (!result.ok) throw new Error(`Failed to restore ${snapshot.path}: ${result.error.message}`);
			}
		},
		readFile(): string | undefined {
			return undefined;
		},
		writeFile(): void {
			throw new Error("ExecutionEnv checkpoint store does not support direct writeFile");
		},
		deleteFile(): void {
			throw new Error("ExecutionEnv checkpoint store does not support direct deleteFile");
		},
	};
}

export function safeCheckpointPath(path: string): string {
	return safePath(path);
}

function safePath(path: string): string {
	return normalizeWriteScopePath(path);
}

function assertValidAttempt(attempt: number): void {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new Error(`invalid checkpoint attempt: ${attempt}`);
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "not_found";
}

function initialEntries(files: CheckpointStoreOptions["files"]): Array<[string, string]> {
	if (!files) return [];
	if (files instanceof Map) return [...files.entries()];
	return Object.entries(files);
}
