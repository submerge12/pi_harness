import type { AgentTool, ExecutionEnv, FileError } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import { sandboxRoots, resolveWritableWithinRoots } from "../sandbox.ts";

const writeParameters = Type.Object({
	path: Type.String(),
	content: Type.String(),
});

export interface WriteToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
}

export interface WriteToolDetails {
	toolCallId: string;
	path: string;
	charactersWritten: number;
}

type WriteParameters = Static<typeof writeParameters>;

export function createWriteTool(options: WriteToolOptions): AgentTool<typeof writeParameters, WriteToolDetails> {
	return {
		name: "write",
		label: "Write",
		description: "Creates or overwrites a UTF-8 text file inside the sandbox.",
		parameters: writeParameters,
		async execute(toolCallId: string, params: WriteParameters, signal?: AbortSignal) {
			const resolvedPath = await resolveWritableWithinRoots(options.env, sandboxRoots(options.env.cwd, options.roots), params.path, signal);
			const result = await options.env.writeFile(resolvedPath, params.content, signal);
			if (!result.ok) throw fileOperationError("write", resolvedPath, result.error);

			return {
				content: [{ type: "text", text: `Wrote ${params.content.length} characters to ${resolvedPath}` }],
				details: { toolCallId, path: resolvedPath, charactersWritten: params.content.length },
			};
		},
	};
}

function fileOperationError(action: string, filePath: string, error: FileError): Error {
	return new Error(`Failed to ${action} ${filePath}: ${error.message}`);
}
