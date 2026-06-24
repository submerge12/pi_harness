import type { AgentTool, ExecutionEnv, FileError } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { CheckpointStore } from "../../checkpoint/index.ts";
import type { EvidenceGateway } from "../../evidence/index.ts";
import { sandboxRoots, resolveWritableWithinRoots } from "../sandbox.ts";
import type { ToolPermissionDecisionLookup } from "../types.ts";

const writeParameters = Type.Object({
	path: Type.String(),
	content: Type.String(),
});

export interface WriteToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	evidenceGateway?: EvidenceGateway;
	getPermissionDecision?: ToolPermissionDecisionLookup;
	checkpoint?: CheckpointStore;
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
			await options.checkpoint?.snapshotCurrent?.(params.path);
			const result = await options.env.writeFile(resolvedPath, params.content, signal);
			if (!result.ok) throw fileOperationError("write", resolvedPath, result.error);
			await captureWriteEvidence(options, toolCallId, params.path, params.content.length);

			return {
				content: [{ type: "text", text: `Wrote ${params.content.length} characters to ${resolvedPath}` }],
				details: { toolCallId, path: resolvedPath, charactersWritten: params.content.length },
			};
		},
	};
}

async function captureWriteEvidence(
	options: WriteToolOptions,
	toolCallId: string,
	path: string,
	charactersWritten: number,
): Promise<void> {
	if (!options.evidenceGateway) return;
	const permissionDecision = options.getPermissionDecision?.(toolCallId);
	await options.evidenceGateway.captureOutput({
		id: toolCallId,
		command: `write ${path}`,
		subject: permissionDecision?.subject || path,
		allowed: permissionDecision?.allowed ?? { level: "ask" },
		...(permissionDecision?.writeScope ? { writeScope: permissionDecision.writeScope } : {}),
		actualWritePaths: [permissionDecision?.subject || path],
		stdout: `Wrote ${charactersWritten} characters to ${path}`,
		exitCode: 0,
	});
}

function fileOperationError(action: string, filePath: string, error: FileError): Error {
	return new Error(`Failed to ${action} ${filePath}: ${error.message}`);
}
