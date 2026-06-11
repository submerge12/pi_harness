import type { AgentTool, ExecutionEnv, FileError, FileInfo } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import { sandboxRoots, resolveExistingWithinRoots, truncateText, DEFAULT_MAX_OUTPUT_CHARS } from "../sandbox.ts";

const lsParameters = Type.Object({
	path: Type.Optional(Type.String()),
});

export interface LsToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
}

export interface LsToolDetails {
	toolCallId: string;
	path: string;
	entries: number;
	truncated: boolean;
	originalLength: number;
}

type LsParameters = Static<typeof lsParameters>;

export function createLsTool(options: LsToolOptions): AgentTool<typeof lsParameters, LsToolDetails> {
	return {
		name: "ls",
		label: "List",
		description: "Lists direct children of a sandboxed directory.",
		parameters: lsParameters,
		async execute(toolCallId: string, params: LsParameters, signal?: AbortSignal) {
			const requestedPath = params.path ?? ".";
			const resolvedPath = await resolveExistingWithinRoots(options.env, sandboxRoots(options.env.cwd, options.roots), requestedPath, signal);
			const result = await options.env.listDir(resolvedPath, signal);
			if (!result.ok) throw fileOperationError("list", resolvedPath, result.error);

			const text = result.value.sort(compareFileInfo).map(formatFileInfo).join("\n");
			const output = truncateText(text, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					toolCallId,
					path: resolvedPath,
					entries: result.value.length,
					truncated: output.truncated,
					originalLength: output.originalLength,
				},
			};
		},
	};
}

function compareFileInfo(left: FileInfo, right: FileInfo): number {
	if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
	return left.name.localeCompare(right.name);
}

function formatFileInfo(info: FileInfo): string {
	return `${info.kind} ${info.name}`;
}

function fileOperationError(action: string, filePath: string, error: FileError): Error {
	return new Error(`Failed to ${action} ${filePath}: ${error.message}`);
}
