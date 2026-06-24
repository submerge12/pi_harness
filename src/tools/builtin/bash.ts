import type { AgentTool, ExecutionEnv, ExecutionError } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { EvidenceGateway } from "../../evidence/index.ts";
import { getEvidenceCapturedOutput } from "../../evidence/index.ts";
import { evaluateCommandRules, type CommandRule } from "../../policy/profiles.ts";
import { sandboxRoots, resolveExistingWithinRoots, truncateText, DEFAULT_MAX_OUTPUT_CHARS } from "../sandbox.ts";
import type { ToolPermissionDecisionLookup } from "../types.ts";

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
	evidenceGateway?: EvidenceGateway;
	getPermissionDecision?: ToolPermissionDecisionLookup;
	commandRules?: readonly CommandRule[];
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
			const timeout = params.timeoutSeconds ?? options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
			const commandDecision = evaluateCommandRules(options.commandRules, params.command);
			if (!commandDecision.allowed) {
				throw new Error(`Command denied by rule ${commandDecision.ruleId ?? "unknown"}`);
			}
			const capturedResult = options.evidenceGateway
				? await executeWithEvidence(options, toolCallId, params.command, cwd, timeout, signal)
				: await executeDirectly(options, params.command, cwd, timeout, signal);

			const output = truncateText(formatExecResult(capturedResult), options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
			return {
				content: [{ type: "text", text: output.text }],
				details: { toolCallId, command: params.command, cwd, exitCode: capturedResult.exitCode, truncated: output.truncated, originalLength: output.originalLength },
			};
		},
	};
}

async function executeWithEvidence(
	options: BashToolOptions,
	toolCallId: string,
	command: string,
	cwd: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	if (!options.evidenceGateway) throw new Error("Evidence gateway missing");
	const permissionDecision = options.getPermissionDecision?.(toolCallId);
	const entry = await options.evidenceGateway.captureCommand(
		{
			id: toolCallId,
			command,
			subject: permissionDecision?.subject ?? command,
			allowed: permissionDecision?.allowed ?? { level: "ask" },
			...(permissionDecision?.writeScope ? { writeScope: permissionDecision.writeScope } : {}),
			actualWritePaths: [],
			cwd,
			timeout,
		},
		signal,
	);
	const captured = getEvidenceCapturedOutput(entry);
	if (!captured) throw new Error(`Evidence output unavailable for ${toolCallId}`);
	return captured;
}

async function executeDirectly(
	options: BashToolOptions,
	command: string,
	cwd: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const result = await options.env.exec(command, {
		cwd,
		timeout,
		abortSignal: signal,
	});
	if (!result.ok) throw executionError(command, result.error);
	return result.value;
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
