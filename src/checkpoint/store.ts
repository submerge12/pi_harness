import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import path from "node:path";
import { normalizeWriteScopePath } from "../execution/index.ts";
import { resolveWritableWithinRoots, sandboxRoots } from "../tools/sandbox.ts";
import type { CheckpointStore, CheckpointStoreOptions } from "./types.ts";

interface Snapshot {
	path: string;
	existed: boolean;
	content?: string;
	/** Binary-safe snapshot content used by the execution-env store. */
	bytes?: Uint8Array;
}

const DEFAULT_MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES = 128 * 1024 * 1024;

interface AttemptBaseline {
	roots: readonly string[];
	paths: ReadonlySet<string>;
}

export function createInMemoryCheckpointStore(options: CheckpointStoreOptions): CheckpointStore {
	const files = new Map<string, string>();
	const snapshotsByAttempt = new Map<number, Snapshot[]>();
	const baselinesByAttempt = new Map<number, AttemptBaseline>();
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
		baselineAttempt(attempt: number, writeScope: readonly string[]): void {
			assertValidAttempt(attempt);
			const roots = scopeRoots(writeScope);
			const paths = new Set([...files.keys()].filter((filePath) => roots.some((root) => isWithinScopeRoot(filePath, root))));
			for (const filePath of paths) this.snapshot(attempt, filePath);
			baselinesByAttempt.set(attempt, { roots, paths });
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
			const baseline = baselinesByAttempt.get(fromAttempt);
			if (baseline) {
				for (const filePath of [...files.keys()]) {
					if (baseline.paths.has(filePath)) continue;
					if (baseline.roots.some((root) => isWithinScopeRoot(filePath, root))) files.delete(filePath);
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
	/** Per-file snapshot cap; a larger file fails the baseline loudly rather than exhausting memory. */
	maxFileBytes?: number;
	/** Per-attempt total snapshot cap across all files. */
	maxTotalBytes?: number;
}

export function createExecutionEnvCheckpointStore(options: ExecutionEnvCheckpointStoreOptions): CheckpointStore {
	const snapshotsByAttempt = new Map<number, Snapshot[]>();
	const baselinesByAttempt = new Map<number, AttemptBaseline>();
	const bytesByAttempt = new Map<number, number>();
	let activeAttempt: number | undefined;
	const roots = sandboxRoots(options.env.cwd, options.roots);
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_SNAPSHOT_FILE_BYTES;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES;

	return {
		beginAttempt(attempt: number): void {
			assertValidAttempt(attempt);
			activeAttempt = attempt;
		},
		finishAttempt(): void {
			activeAttempt = undefined;
		},
		async baselineAttempt(attempt: number, writeScope: readonly string[]): Promise<void> {
			assertValidAttempt(attempt);
			const scopeRootsForAttempt = scopeRoots(writeScope);
			const paths = new Set<string>();
			for (const scopeRoot of scopeRootsForAttempt) {
				for (const filePath of await collectExistingFiles(options.env, scopeRoot)) {
					paths.add(filePath);
				}
			}
			for (const filePath of paths) await this.snapshot(attempt, filePath);
			baselinesByAttempt.set(attempt, { roots: scopeRootsForAttempt, paths });
		},
		async snapshot(attempt: number, path: string): Promise<void> {
			assertValidAttempt(attempt);
			const normalizedPath = safePath(path);
			const resolvedPath = await resolveWritableWithinRoots(options.env, roots, normalizedPath);
			const snapshots = snapshotsByAttempt.get(attempt) ?? [];
			if (snapshots.some((snapshot) => snapshot.path === normalizedPath)) return;
			const info = await options.env.fileInfo(resolvedPath);
			if (!info.ok) {
				if (!isNotFound(info.error)) {
					throw new Error(
						`Failed to snapshot ${normalizedPath} for rewind: ${info.error.message}`,
					);
				}
				snapshots.push({ path: normalizedPath, existed: false });
				snapshotsByAttempt.set(attempt, snapshots);
				return;
			}
			if (info.value.size > maxFileBytes) {
				throw new Error(
					`Cannot snapshot ${normalizedPath} for rewind: ${info.value.size} bytes exceeds the ` +
						`${maxFileBytes}-byte per-file cap. Narrow the writeScope or raise maxFileBytes.`,
				);
			}
			// Binary-safe: byte snapshots round-trip non-UTF-8 content that text decoding would corrupt.
			const readResult = await options.env.readBinaryFile(resolvedPath);
			if (readResult.ok) {
				const total = (bytesByAttempt.get(attempt) ?? 0) + readResult.value.byteLength;
				if (total > maxTotalBytes) {
					throw new Error(
						`Cannot snapshot ${normalizedPath} for rewind: attempt snapshot total would exceed the ` +
							`${maxTotalBytes}-byte cap. Narrow the writeScope or raise maxTotalBytes.`,
					);
				}
				bytesByAttempt.set(attempt, total);
				snapshots.push({ path: normalizedPath, existed: true, bytes: readResult.value });
			} else if (isNotFound(readResult.error)) {
				snapshots.push({ path: normalizedPath, existed: false });
			} else {
				throw new Error(`Failed to snapshot ${normalizedPath} for rewind: ${readResult.error.message}`);
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
					? await options.env.writeFile(resolvedPath, snapshot.bytes ?? snapshot.content ?? "")
					: await options.env.remove(resolvedPath);
				if (!result.ok) throw new Error(`Failed to restore ${snapshot.path}: ${result.error.message}`);
			}
			const baseline = baselinesByAttempt.get(fromAttempt);
			if (baseline) {
				for (const scopeRoot of baseline.roots) {
					for (const filePath of await collectExistingFiles(options.env, scopeRoot)) {
						if (baseline.paths.has(filePath)) continue;
						const resolvedPath = await resolveWritableWithinRoots(options.env, roots, filePath);
						const result = await options.env.remove(resolvedPath);
						if (!result.ok && !isNotFound(result.error)) {
							throw new Error(`Failed to remove created file ${filePath}: ${result.error.message}`);
						}
					}
				}
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

function scopeRoots(writeScope: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const scope of writeScope) {
		const root = scopeRoot(scope);
		if (root) roots.add(root);
	}
	return [...roots];
}

function scopeRoot(scope: string): string | undefined {
	const normalized = safePath(scope);
	if (normalized.includes("://")) return undefined;
	return normalized.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
}

function isWithinScopeRoot(filePath: string, scopeRoot: string): boolean {
	return filePath === scopeRoot || filePath.startsWith(`${scopeRoot}/`);
}

async function collectExistingFiles(env: ExecutionEnv, scopeRoot: string): Promise<string[]> {
	const info = await env.fileInfo(scopeRoot);
	if (!info.ok) {
		if (isNotFound(info.error)) return [];
		throw new Error(`Failed to inspect checkpoint scope ${scopeRoot}: ${info.error.message}`);
	}
	if (info.value.kind === "file") return [safePath(scopeRoot)];
	if (info.value.kind !== "directory") return [];

	const files: string[] = [];
	await collectFilesUnderDirectory(env, scopeRoot, files);
	return files;
}

async function collectFilesUnderDirectory(env: ExecutionEnv, directory: string, files: string[]): Promise<void> {
	const entries = await env.listDir(directory);
	if (!entries.ok) {
		if (isNotFound(entries.error)) return;
		throw new Error(`Failed to list checkpoint scope ${directory}: ${entries.error.message}`);
	}
	for (const entry of entries.value) {
		const relativePath = safePath(toWorkspaceRelative(env.cwd, entry.path));
		if (entry.kind === "file") {
			files.push(relativePath);
		} else if (entry.kind === "directory") {
			await collectFilesUnderDirectory(env, relativePath, files);
		}
	}
}

function toWorkspaceRelative(cwd: string, candidate: string): string {
	const normalizedCwd = trimTrailingSlash(cwd.replaceAll("\\", "/"));
	const normalizedCandidate = candidate.replaceAll("\\", "/");
	if (normalizedCandidate === normalizedCwd) return ".";
	if (normalizedCandidate.startsWith(`${normalizedCwd}/`)) return normalizedCandidate.slice(normalizedCwd.length + 1);
	return path.relative(cwd, candidate).replaceAll("\\", "/");
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function initialEntries(files: CheckpointStoreOptions["files"]): Array<[string, string]> {
	if (!files) return [];
	if (files instanceof Map) return [...files.entries()];
	return Object.entries(files);
}
