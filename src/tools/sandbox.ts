import * as path from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

export const DEFAULT_MAX_OUTPUT_CHARS = 30_000;

export interface TruncatedText {
	text: string;
	truncated: boolean;
	originalLength: number;
}

export class SandboxPathError extends Error {
	constructor(root: string, requestedPath: string) {
		super(`Path ${requestedPath} escapes sandbox root ${root}`);
		this.name = "SandboxPathError";
	}
}

export function resolveWithinRoot(root: string, requestedPath: string): string {
	const flavor = pathFlavor(root);
	if (!isAbsolutePath(root, flavor)) throw new Error(`Sandbox root must be absolute: ${root}`);
	if (flavor === "posix" && isWindowsAbsolutePath(requestedPath)) throw new SandboxPathError(root, requestedPath);
	if (isWindowsDriveRelativePath(requestedPath)) throw new SandboxPathError(root, requestedPath);

	const pathApi = flavor === "windows" ? path.win32 : path.posix;
	const normalizedRoot = normalizeRoot(root, flavor);
	const resolvedPath = pathApi.resolve(normalizedRoot, requestedPath);
	const normalizedPath = normalizePath(resolvedPath, flavor);

	if (!isSameOrChildPath(normalizedRoot, normalizedPath, flavor)) throw new SandboxPathError(root, requestedPath);
	return normalizedPath;
}

export function resolveWithinRoots(roots: readonly string[], requestedPath: string): string {
	let lastError: Error | undefined;
	for (const root of roots) {
		try {
			return resolveWithinRoot(root, requestedPath);
		} catch (error) {
			if (error instanceof Error) lastError = error;
		}
	}
	throw lastError ?? new Error(`No sandbox roots configured for ${requestedPath}`);
}

export async function resolveExistingWithinRoots(
	env: ExecutionEnv,
	roots: readonly string[],
	requestedPath: string,
	signal?: AbortSignal,
): Promise<string> {
	let lastError: Error | undefined;
	for (const root of roots) {
		try {
			const resolvedPath = resolveWithinRoot(root, requestedPath);
			const canonicalPath = await canonicalExistingPath(env, resolvedPath, signal);
			await assertCanonicalWithinRoot(env, root, requestedPath, canonicalPath, signal);
			return resolvedPath;
		} catch (error) {
			if (error instanceof Error) lastError = error;
		}
	}
	throw lastError ?? new Error(`No sandbox roots configured for ${requestedPath}`);
}

export async function resolveWritableWithinRoots(
	env: ExecutionEnv,
	roots: readonly string[],
	requestedPath: string,
	signal?: AbortSignal,
): Promise<string> {
	let lastError: Error | undefined;
	for (const root of roots) {
		try {
			const resolvedPath = resolveWithinRoot(root, requestedPath);
			const canonicalPath = await canonicalWritablePath(env, resolvedPath, signal);
			await assertCanonicalWithinRoot(env, root, requestedPath, canonicalPath, signal);
			return resolvedPath;
		} catch (error) {
			if (error instanceof Error) lastError = error;
		}
	}
	throw lastError ?? new Error(`No sandbox roots configured for ${requestedPath}`);
}

export function sandboxRoots(cwd: string, roots?: readonly string[]): readonly string[] {
	return roots && roots.length > 0 ? [...roots] : [cwd];
}

export function truncateText(text: string, maxChars = DEFAULT_MAX_OUTPUT_CHARS): TruncatedText {
	if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
	const prefix = text.slice(0, maxChars);
	const separator = prefix.endsWith("\n") || prefix.endsWith("\r") ? "\n" : "\n\n";
	return {
		text: `${prefix}${separator}[Output truncated to ${maxChars} of ${text.length} characters.]`,
		truncated: true,
		originalLength: text.length,
	};
}

type PathFlavor = "windows" | "posix";

function pathFlavor(root: string): PathFlavor {
	return isWindowsAbsolutePath(root) || root.includes("\\") ? "windows" : "posix";
}

function isAbsolutePath(value: string, flavor: PathFlavor): boolean {
	return flavor === "windows" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || /^\/\/[^/]+\/[^/]+/.test(value);
}

function isWindowsDriveRelativePath(value: string): boolean {
	return /^[A-Za-z]:(?:$|[^\\/])/.test(value);
}

function normalizeRoot(root: string, flavor: PathFlavor): string {
	return trimTrailingSeparators(normalizePath(root, flavor), flavor);
}

function normalizePath(value: string, flavor: PathFlavor): string {
	return flavor === "windows" ? path.win32.normalize(value) : path.posix.normalize(value);
}

function trimTrailingSeparators(value: string, flavor: PathFlavor): string {
	const separator = flavor === "windows" ? "\\" : "/";
	const parsedRoot = flavor === "windows" ? path.win32.parse(value).root : path.posix.parse(value).root;
	let result = value;
	while (result.length > parsedRoot.length && result.endsWith(separator)) result = result.slice(0, -1);
	return result;
}

function isSameOrChildPath(root: string, requestedPath: string, flavor: PathFlavor): boolean {
	const separator = flavor === "windows" ? "\\" : "/";
	const comparableRoot = comparablePath(root, flavor);
	const comparablePathValue = comparablePath(requestedPath, flavor);
	if (comparablePathValue === comparableRoot) return true;
	const rootWithSeparator = comparableRoot.endsWith(separator) ? comparableRoot : `${comparableRoot}${separator}`;
	return comparablePathValue.startsWith(rootWithSeparator);
}

function comparablePath(value: string, flavor: PathFlavor): string {
	const normalized = trimTrailingSeparators(normalizePath(value, flavor), flavor);
	return flavor === "windows" ? normalized.toLowerCase() : normalized;
}

async function canonicalExistingPath(env: ExecutionEnv, filePath: string, signal?: AbortSignal): Promise<string> {
	const result = await env.canonicalPath(filePath, signal);
	if (!result.ok) throw new Error(`Failed to canonicalize ${filePath}: ${result.error.message}`);
	return result.value;
}

async function canonicalWritablePath(env: ExecutionEnv, filePath: string, signal?: AbortSignal): Promise<string> {
	const ancestor = await findExistingAncestor(env, filePath, signal);
	const canonicalAncestor = await canonicalExistingPath(env, ancestor, signal);
	const flavor = pathFlavor(filePath);
	const pathApi = flavor === "windows" ? path.win32 : path.posix;
	const relative = pathApi.relative(ancestor, filePath);
	return normalizePath(relative ? pathApi.join(canonicalAncestor, relative) : canonicalAncestor, flavor);
}

async function findExistingAncestor(env: ExecutionEnv, filePath: string, signal?: AbortSignal): Promise<string> {
	const flavor = pathFlavor(filePath);
	const pathApi = flavor === "windows" ? path.win32 : path.posix;
	let current = filePath;
	while (true) {
		const exists = await env.exists(current, signal);
		if (!exists.ok) throw new Error(`Failed to inspect ${current}: ${exists.error.message}`);
		if (exists.value) return current;
		const parent = pathApi.dirname(current);
		if (parent === current) throw new Error(`No existing ancestor for ${filePath}`);
		current = parent;
	}
}

async function assertCanonicalWithinRoot(
	env: ExecutionEnv,
	root: string,
	requestedPath: string,
	canonicalPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const canonicalRoot = await canonicalExistingPath(env, normalizeRoot(root, pathFlavor(root)), signal);
	const flavor = pathFlavor(root);
	const normalizedRoot = normalizeRoot(canonicalRoot, flavor);
	const normalizedPath = normalizePath(canonicalPath, flavor);
	if (!isSameOrChildPath(normalizedRoot, normalizedPath, flavor)) throw new SandboxPathError(root, requestedPath);
}
