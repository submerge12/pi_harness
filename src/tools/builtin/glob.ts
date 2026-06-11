import type { AgentTool, ExecutionEnv, FileError, FileInfo } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import { sandboxRoots, resolveExistingWithinRoots, truncateText, DEFAULT_MAX_OUTPUT_CHARS } from "../sandbox.ts";

const globParameters = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	maxMatches: Type.Optional(Type.Number({ minimum: 1 })),
});

export interface GlobToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
	maxMatches?: number;
}

export interface GlobToolDetails {
	toolCallId: string;
	path: string;
	matches: number;
	truncated: boolean;
	originalLength: number;
}

type GlobParameters = Static<typeof globParameters>;

export function createGlobTool(options: GlobToolOptions): AgentTool<typeof globParameters, GlobToolDetails> {
	return {
		name: "glob",
		label: "Glob",
		description: "Finds files under a sandboxed path that match a glob pattern.",
		parameters: globParameters,
		async execute(toolCallId: string, params: GlobParameters, signal?: AbortSignal) {
			const resolvedPath = await resolveExistingWithinRoots(options.env, sandboxRoots(options.env.cwd, options.roots), params.path ?? ".", signal);
			const matches = await globPath(options.env, resolvedPath, globToRegExp(params.pattern), matchLimit(options, params), signal);
			const output = truncateText(matches.join("\n"), options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
			return {
				content: [{ type: "text", text: output.text }],
				details: { toolCallId, path: resolvedPath, matches: matches.length, truncated: output.truncated, originalLength: output.originalLength },
			};
		},
	};
}

async function globPath(
	env: ExecutionEnv,
	rootPath: string,
	pattern: RegExp,
	limit: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const matches: string[] = [];
	await collectGlobMatches(env, rootPath, rootPath, pattern, limit, matches, signal);
	return matches;
}

async function collectGlobMatches(
	env: ExecutionEnv,
	rootPath: string,
	filePath: string,
	pattern: RegExp,
	limit: number,
	matches: string[],
	signal?: AbortSignal,
): Promise<void> {
	if (matches.length >= limit) return;
	const info = await fileInfo(env, filePath, signal);
	if (info.kind === "file" && pattern.test(relativePath(rootPath, filePath))) matches.push(filePath);
	if (info.kind !== "directory") return;
	const entries = await listDir(env, filePath, signal);
	for (const entry of entries.sort(compareFileInfo)) await collectGlobMatches(env, rootPath, entry.path, pattern, limit, matches, signal);
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		const next = pattern[index + 1];
		if (char === "*" && next === "*") {
			source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
			index += pattern[index + 2] === "/" ? 2 : 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += escapeRegExp(char);
	}
	return new RegExp(`${source}$`);
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

function relativePath(rootPath: string, filePath: string): string {
	return filePath.slice(rootPath.length).replace(/^[\\/]/, "").replaceAll("\\", "/");
}

function matchLimit(options: GlobToolOptions, params: GlobParameters): number {
	return params.maxMatches ?? options.maxMatches ?? 100;
}

function compareFileInfo(left: FileInfo, right: FileInfo): number {
	if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
	return left.name.localeCompare(right.name);
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function fileOperationError(action: string, filePath: string, error: FileError): Error {
	return new Error(`Failed to ${action} ${filePath}: ${error.message}`);
}
