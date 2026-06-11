import type { AgentTool, ExecutionEnv, FileError } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import { sandboxRoots, resolveExistingWithinRoots, truncateText, DEFAULT_MAX_OUTPUT_CHARS } from "../sandbox.ts";

const readParameters = Type.Object({
	path: Type.String(),
});

export interface ReadToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
}

export interface ReadToolDetails {
	toolCallId: string;
	path: string;
	truncated: boolean;
	originalLength: number;
}

type ReadParameters = Static<typeof readParameters>;

export function createReadTool(options: ReadToolOptions): AgentTool<typeof readParameters, ReadToolDetails> {
	return {
		name: "read",
		label: "Read",
		description: "Reads a UTF-8 text file inside the sandbox.",
		parameters: readParameters,
		async execute(toolCallId: string, params: ReadParameters, signal?: AbortSignal) {
			const resolvedPath = await resolveExistingWithinRoots(options.env, sandboxRoots(options.env.cwd, options.roots), params.path, signal);
			const result = await options.env.readTextFile(resolvedPath, signal);
			if (!result.ok) throw fileOperationError("read", resolvedPath, result.error);

			const output = truncateText(result.value, options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					toolCallId,
					path: resolvedPath,
					truncated: output.truncated,
					originalLength: output.originalLength,
				},
			};
		},
	};
}

function fileOperationError(action: string, filePath: string, error: FileError): Error {
	return new Error(`Failed to ${action} ${filePath}: ${error.message}`);
}
