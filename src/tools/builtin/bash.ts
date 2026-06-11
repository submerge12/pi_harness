import type { AgentTool, ExecutionEnv, ExecutionError } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import { sandboxRoots, resolveExistingWithinRoots, truncateText, DEFAULT_MAX_OUTPUT_CHARS } from "../sandbox.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;

const bashParameters = Type.Object({
	command: Type.String(),
	cwd: Type.Optional(Type.String()),
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
});

export interface BashToolOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
	defaultTimeoutSeconds?: number;
}

export interface BashToolDetails {
	toolCallId: string;
	command: string;
	cwd: string;
	exitCode: number;
	truncated: boolean;
	originalLength: number;
}

type BashParameters = Static<typeof bashParameters>;

export function createBashTool(options: BashToolOptions): AgentTool<typeof bashParameters, BashToolDetails> {
	return {
		name: "bash",
		label: "Bash",
		description: "Runs a shell command inside the sandbox working directory.",
		parameters: bashParameters,
		async execute(toolCallId: string, params: BashParameters, signal?: AbortSignal) {
			const cwd = await resolveExistingWithinRoots(options.env, sandboxRoots(options.env.cwd, options.roots), params.cwd ?? ".", signal);
			const result = await options.env.exec(params.command, {
				cwd,
				timeout: params.timeoutSeconds ?? options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
				abortSignal: signal,
			});
			if (!result.ok) throw executionError(params.command, result.error);

			const output = truncateText(formatExecResult(result.value), options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
			return {
				content: [{ type: "text", text: output.text }],
				details: { toolCallId, command: params.command, cwd, exitCode: result.value.exitCode, truncated: output.truncated, originalLength: output.originalLength },
			};
		},
	};
}

function formatExecResult(result: { stdout: string; stderr: string; exitCode: number }): string {
	const sections = [`exitCode: ${result.exitCode}`];
	if (result.stdout.length > 0) sections.push(`stdout:\n${result.stdout}`);
	if (result.stderr.length > 0) sections.push(`stderr:\n${result.stderr}`);
	return sections.join("\n");
}

function executionError(command: string, error: ExecutionError): Error {
	return new Error(`Failed to execute ${command}: ${error.message}`);
}
