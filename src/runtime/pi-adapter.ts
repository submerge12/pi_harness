import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRequestResult } from "../lifecycle/index.ts";
import { findModelProfile } from "../model-profiles/registry.ts";
import type { AgentRuntimeAdapter, ExecutorCapabilities, PiRuntimeHarness, WorkerAssignment } from "./types.ts";
import type { NormalizedResult } from "./schemas/normalized-result.ts";

const DEFAULT_CONTEXT_TOKENS = 0;

export function createPiRuntimeAdapter(harness: PiRuntimeHarness): AgentRuntimeAdapter {
	return {
		id: "pi",
		capabilities(): ExecutorCapabilities {
			const config = harness.getConfig();
			const tools = configuredToolNames(config);
			return {
				canEdit: hasAnyTool(tools, ["write", "edit"]),
				canRunCommands: hasAnyTool(tools, ["bash"]),
				canNetwork: hasAnyTool(tools, ["fetch"]),
				maxContextTokens: config.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
				supportsThinking: config.thinkingLevel !== undefined && config.thinkingLevel !== "off",
			};
		},
		async run(assignment: WorkerAssignment, signal?: AbortSignal): Promise<NormalizedResult> {
			if (signal?.aborted) {
				return {
					status: "blocked",
					testResults: [],
					evidenceRefs: [],
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
					message: "assignment aborted before execution",
				};
			}

			const result = await harness.runRequest({ taskContract: assignment });
			const model = executedModelId(harness.getConfig());
			return {
				...normalizeAgentRequestResult(result),
				...(model ? { model } : {}),
			};
		},
	};
}

export const createAgentRuntimeAdapter = createPiRuntimeAdapter;

function executedModelId(config: ReturnType<PiRuntimeHarness["getConfig"]>): string | undefined {
	if (!config.provider || !config.modelId) return undefined;
	const profile = findModelProfile({ provider: config.provider, modelId: config.modelId });
	return profile?.id ?? `${config.provider}/${config.modelId}`;
}

function configuredToolNames(config: ReturnType<PiRuntimeHarness["getConfig"]>): readonly string[] | undefined {
	if (config.activeToolNames) return [...config.activeToolNames];
	if (config.toolRegistrations) return config.toolRegistrations.map((registration) => registration.tool.name);
	if (config.tools) return config.tools.map((tool) => tool.name);
	if (config.useDefaultTools !== false) return ["read", "write", "edit", "ls", "grep", "glob", "bash", "fetch"];
	return undefined;
}

function hasAnyTool(toolNames: readonly string[] | undefined, candidates: readonly string[]): boolean {
	if (!toolNames) return false;
	const names = new Set(toolNames);
	return candidates.some((candidate) => names.has(candidate));
}

function normalizeAgentRequestResult(result: AgentRequestResult): NormalizedResult {
	if (result.entryStage !== "execute") {
		return {
			status: "blocked",
			testResults: [],
			evidenceRefs: [],
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
			message: result.clarification,
		};
	}
	return normalizeAssistantMessage(result.message, {
		status: statusFromExecuteResult(result),
		evidenceRefs: result.evidenceRefs,
		diffRef: result.diffRef,
	});
}

function normalizeAssistantMessage(
	message: AssistantMessage,
	options: {
		status?: NormalizedResult["status"];
		evidenceRefs?: readonly string[];
		diffRef?: string;
	} = {},
): NormalizedResult {
	const text = assistantText(message);
	const usage = message.usage;
	return {
		status: options.status ?? (message.stopReason === "error" ? "failed" : "completed"),
		...(options.diffRef ? { diffRef: options.diffRef } : {}),
		// Structured test events are not emitted by a single runRequest yet; receipts keep the raw proof trail.
		testResults: [],
		evidenceRefs: options.evidenceRefs ? [...options.evidenceRefs] : [],
		usage: {
			inputTokens: usage.input,
			outputTokens: usage.output,
			costUsd: usage.cost.total,
		},
		message: text,
	};
}

function statusFromExecuteResult(
	result: Extract<AgentRequestResult, { entryStage: "execute" }>,
): NormalizedResult["status"] {
	if (result.message.stopReason === "error") return "failed";
	if (result.loopState === "FAILED") return "failed";
	if ((result.completionGateFailures?.length ?? 0) > 0) return "failed";
	if (result.reviewVerdicts?.some((verdict) => verdict.verdict === "FAIL" || verdict.verdict === "BLOCKED")) {
		return "failed";
	}
	if (
		result.loopState === "NEEDS_HUMAN" ||
		result.reviewVerdicts?.some((verdict) => verdict.verdict === "NEEDS_HUMAN" || verdict.verdict === "SCOPE_GAP")
	) {
		return "blocked";
	}
	return "completed";
}

function assistantText(message: AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (!("type" in part) || part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.join("");
}
