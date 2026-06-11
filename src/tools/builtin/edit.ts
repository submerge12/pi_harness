import type { AgentTool, ExecutionEnv, FileError } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import { sandboxRoots, resolveExistingWithinRoots } from "../sandbox.ts";

const editParameters = Type.Object({
	path: Type.String(),
	search: Type.String(),
	replace: Type.String(),
});

export interface EditToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
}

export interface EditToolDetails {
	toolCallId: string;
	path: string;
	replacements: number;
}

type EditParameters = Static<typeof editParameters>;

export function createEditTool(options: EditToolOptions): AgentTool<typeof editParameters, EditToolDetails> {
	return {
		name: "edit",
		label: "Edit",
		description: "Replaces exact text in a UTF-8 file inside the sandbox.",
		parameters: editParameters,
		async execute(toolCallId: string, params: EditParameters, signal?: AbortSignal) {
			if (params.search.length === 0) throw new Error("Search text must not be empty");
			const resolvedPath = await resolveExistingWithinRoots(options.env, sandboxRoots(options.env.cwd, options.roots), params.path, signal);
			const readResult = await options.env.readTextFile(resolvedPath, signal);
			if (!readResult.ok) throw fileOperationError("read", resolvedPath, readResult.error);

			const replacements = countOccurrences(readResult.value, params.search);
			if (replacements === 0) throw new Error(`Search text was not found in ${resolvedPath}`);
			const content = readResult.value.split(params.search).join(params.replace);
			const writeResult = await options.env.writeFile(resolvedPath, content, signal);
			if (!writeResult.ok) throw fileOperationError("write", resolvedPath, writeResult.error);

			return {
				content: [{ type: "text", text: `Replaced ${replacements} occurrence(s) in ${resolvedPath}` }],
				details: { toolCallId, path: resolvedPath, replacements },
			};
		},
	};
}

function countOccurrences(content: string, search: string): number {
	return content.split(search).length - 1;
}

function fileOperationError(action: string, filePath: string, error: FileError): Error {
	return new Error(`Failed to ${action} ${filePath}: ${error.message}`);
}
