import type { AgentRequestInput, AgentRequestResult } from "../lifecycle/index.ts";
import type { TaskContract } from "../contract/index.ts";
import type { NormalizedResult } from "./schemas/normalized-result.ts";

export interface ExecutorCapabilities {
	canEdit: boolean;
	canRunCommands: boolean;
	canNetwork: boolean;
	maxContextTokens: number;
	supportsThinking: boolean;
}

export type WorkerAssignment = TaskContract;

export interface AgentRuntimeAdapter {
	id: "pi";
	capabilities(): ExecutorCapabilities;
	run(assignment: WorkerAssignment, signal?: AbortSignal): Promise<NormalizedResult>;
}

export interface PiRuntimeHarness {
	getConfig(): {
		activeToolNames?: readonly string[];
		toolRegistrations?: readonly { tool: { name: string } }[];
		tools?: readonly { name: string }[];
		useDefaultTools?: boolean;
		contextWindow?: number;
		thinkingLevel?: string;
	};
	runRequest(input: AgentRequestInput): Promise<AgentRequestResult>;
}
