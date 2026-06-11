import type { AgentTool, ExecutionEnv, FileError, FileInfo } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import { sandboxRoots, resolveExistingWithinRoots, truncateText, DEFAULT_MAX_OUTPUT_CHARS } from "../sandbox.ts";

const grepParameters = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	maxMatches: Type.Optional(Type.Number({ minimum: 1 })),
});

export interface GrepToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
	maxMatches?: number;
}

export interface GrepToolDetails {
	toolCallId: string;
	path: string;
	matches: number;
	truncated: boolean;
	originalLength: number;
}

type GrepParameters = Static<typeof grepParameters>;

export function createGrepTool(options: GrepToolOptions): AgentTool<typeof grepParameters, GrepToolDetails> {
	return {
		name: "grep",
		label: "Grep",
		description: "Searches UTF-8 files under a sandboxed path with a JavaScript regular expression.",
		parameters: grepParameters,
		async execute(toolCallId: string, params: GrepParameters, signal?: AbortSignal) {
			const resolvedPath = await resolveExistingWithinRoots(options.env, sandboxRoots(options.env.cwd, options.roots), params.path ?? ".", signal);
			const matches = await grepPath(options.env, resolvedPath, new RegExp(params.pattern), matchLimit(options, params), signal);
			const output = truncateText(matches.join("\n"), options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
			return {
				content: [{ type: "text", text: output.text }],
				details: { toolCallId, path: resolvedPath, matches: matches.length, truncated: output.truncated, originalLength: output.originalLength },
			};
		},
	};
}

async function grepPath(
	env: ExecutionEnv,
	filePath: string,
	pattern: RegExp,
	limit: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const matches: string[] = [];
	await collectMatches(env, filePath, pattern, limit, matches, signal);
	return matches;
}

async function collectMatches(
	env: ExecutionEnv,
	filePath: string,
	pattern: RegExp,
	limit: number,
	matches: string[],
	signal?: AbortSignal,
): Promise<void> {
	if (matches.length >= limit) return;
	const info = await fileInfo(env, filePath, signal);
	if (info.kind === "file") {
		await collectFileMatches(env, filePath, pattern, limit, matches, signal);
		return;
	}
	if (info.kind !== "directory") return;
	const entries = await listDir(env, filePath, signal);
	for (const entry of entries.sort(compareFileInfo)) await collectMatches(env, entry.path, pattern, limit, matches, signal);
}

async function collectFileMatches(
	env: ExecutionEnv,
	filePath: string,
	pattern: RegExp,
	limit: number,
	matches: string[],
	signal?: AbortSignal,
): Promise<void> {
	const result = await env.readTextLines(filePath, { abortSignal: signal });
	if (!result.ok) throw fileOperationError("read", filePath, result.error);
	for (const [index, line] of result.value.entries()) {
		if (matches.length >= limit) return;
		if (pattern.test(line)) matches.push(`${filePath}:${index + 1}: ${line}`);
	}
}

async function fileInfo(env: ExecutionEnv, filePath: string, signal?: AbortSignal): Promise<FileInfo> {
	const result = await env.fileInfo(filePath, signal);
	if (!result.ok) throw fileOperationError("stat", filePath, result.error);
	return result.value;
}

async function listDir(env: ExecutionEnv, filePath: string, signal?: AbortSignal): Promise<FileInfo[]> {
	const result = await env.listDir(filePath, signal);
	if (!result.ok) throw fileOperationError("list", filePath, result.error);
	return result.value;
}

function matchLimit(options: GrepToolOptions, params: GrepParameters): number {
	return params.maxMatches ?? options.maxMatches ?? 100;
}

function compareFileInfo(left: FileInfo, right: FileInfo): number {
	if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
	return left.name.localeCompare(right.name);
}

function fileOperationError(action: string, filePath: string, error: FileError): Error {
	return new Error(`Failed to ${action} ${filePath}: ${error.message}`);
}
