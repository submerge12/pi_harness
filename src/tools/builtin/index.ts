import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { CheckpointStore } from "../../checkpoint/index.ts";
import type { EvidenceGateway } from "../../evidence/index.ts";
import type { CommandRule } from "../../policy/index.ts";
import { ToolRegistry } from "../registry.ts";
import type { ToolPermissionDecisionLookup } from "../types.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFetchTool } from "./fetch.ts";
import type { FetchImplementation } from "./fetch.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export interface DefaultToolsetOptions {
	env: ExecutionEnv;
	roots?: readonly string[];
	maxOutputChars?: number;
	bashTimeoutSeconds?: number;
	fetch?: FetchImplementation;
	fetchMaxBytes?: number;
	evidenceGateway?: EvidenceGateway;
	getPermissionDecision?: ToolPermissionDecisionLookup;
	checkpoint?: CheckpointStore;
	commandRules?: readonly CommandRule[];
}

export function createDefaultToolset(options: DefaultToolsetOptions): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register({ tool: createReadTool(options), accessLevel: "read-only" });
	registry.register({ tool: createWriteTool(options), accessLevel: "write" });
	registry.register({ tool: createEditTool(options), accessLevel: "write" });
	registry.register({ tool: createLsTool(options), accessLevel: "read-only" });
	registry.register({ tool: createGrepTool(options), accessLevel: "read-only" });
	registry.register({ tool: createGlobTool(options), accessLevel: "read-only" });
	registry.register({
		tool: createBashTool({ ...options, defaultTimeoutSeconds: options.bashTimeoutSeconds }),
		accessLevel: "destructive",
	});
	registry.register({
		tool: createFetchTool({
			fetch: options.fetch,
			maxBytes: options.fetchMaxBytes,
			evidenceGateway: options.evidenceGateway,
			getPermissionDecision: options.getPermissionDecision,
		}),
		accessLevel: "network",
	});
	return registry;
}

export { createBashTool } from "./bash.ts";
export { createEditTool } from "./edit.ts";
export { createFetchTool } from "./fetch.ts";
export type { FetchImplementation } from "./fetch.ts";
export { createGlobTool } from "./glob.ts";
export { createGrepTool } from "./grep.ts";
export { createLsTool } from "./ls.ts";
export { createReadTool } from "./read.ts";
export { createSpawnAgentTool } from "./spawn-agent.ts";
export { createWriteTool } from "./write.ts";
