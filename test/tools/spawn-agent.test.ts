import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { Object as TypeObject } from "typebox";
import type { HarnessConfig } from "../../src/config.ts";
import type { EvidenceGateway } from "../../src/evidence/index.ts";
import type { GenericHarnessRuntimeOptions } from "../../src/harness.ts";
import { resolveHarnessConfig } from "../../src/config.ts";
import { createAgent } from "../../src/agents/create-agent.ts";
import type { AgentProfile } from "../../src/agents/profile.ts";
import { mergeStricterPolicies, stricterPermission } from "../../src/agents/merge.ts";
import { decide } from "../../src/policy/decide.ts";
import { createSpawnAgentTool } from "../../src/tools/builtin/spawn-agent.ts";
import type { PermissionPolicy, ToolAccessLevel, ToolRegistration } from "../../src/tools/types.ts";
import type { TaskContract } from "../../src/contract/index.ts";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const childProfile: AgentProfile = {
	name: "travel",
	description: "Travel",
	systemPrompt: "travel",
	policy: {
		defaults: {
			"read-only": "allow",
			write: "allow",
			destructive: "ask",
			network: "allow",
		},
		tools: { travel_analyze: "allow" },
	},
};

const taskContract: TaskContract = {
	id: "task-contract-1",
	goal: "Check delegated commute",
	rawRequest: "Can you check tomorrow commute?",
	hardConstraints: [{ kind: "date", value: "tomorrow", source: "user" }],
	assignedSkill: "travel-planning",
	writeScope: ["src/child"],
	allowedTools: ["read", "write"],
	gateTier: "G1",
	planNodeId: "plan-node-1",
};

function createToolRegistration(name: string, accessLevel: ToolAccessLevel): ToolRegistration {
	return {
		tool: {
			name,
			label: name,
			description: `${name} description`,
			parameters: TypeObject({}),
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "ok" }],
				details: { ok: true },
			}),
		},
		accessLevel,
	};
}

describe("spawn_agent", () => {
	it("chooses the stricter permission when merging parent and child policies", () => {
		expect(stricterPermission("allow", "ask")).toBe("ask");
		expect(stricterPermission("ask", "deny")).toBe("deny");
		expect(stricterPermission("allow", undefined)).toBe("allow");
		expect(
			mergeStricterPolicies(
				{
					defaults: { "read-only": "allow", write: "allow", destructive: "deny", network: "allow" },
					tools: { travel_analyze: "allow" },
				},
				{
					defaults: { "read-only": "allow", write: "ask", destructive: "ask", network: "deny" },
					tools: { travel_analyze: "ask" },
				},
			),
		).toEqual({
			defaults: { "read-only": "allow", write: "ask", destructive: "deny", network: "deny" },
			tools: { travel_analyze: "ask" },
		});
	});

	it("does not let a child tool allow weaken an inherited default deny for known tool access", () => {
		expect(
			mergeStricterPolicies(
				{
					defaults: { "read-only": "allow", write: "deny", destructive: "ask", network: "ask" },
				},
				{
					defaults: { "read-only": "allow", write: "allow", destructive: "ask", network: "ask" },
					tools: { travel_write: "allow", unknown_write: "allow" },
				},
				{ travel_write: "write" },
			),
		).toEqual({
			defaults: { "read-only": "allow", write: "deny", destructive: "ask", network: "ask" },
			tools: { travel_write: "deny", unknown_write: "allow" },
		});
	});

	it("does not let a child scoped allow weaken an inherited scoped deny for the same subject", () => {
		expect(
			mergeStricterPolicies(
				{
					defaults: { "read-only": "allow", write: "ask", destructive: "ask", network: "ask" },
					rules: [{ id: "parent-deny", toolName: "write", subject: "secrets/**", level: "deny" }],
				},
				{
					defaults: { "read-only": "allow", write: "ask", destructive: "ask", network: "ask" },
					rules: [{ id: "child-allow", toolName: "write", subject: "secrets/**", level: "allow" }],
				},
			).rules,
		).toEqual([{ id: "parent-deny", toolName: "write", subject: "secrets/**", level: "deny" }]);
	});

	it("preserves broader parent scoped deny rules alongside child scoped allows", () => {
		const policy = mergeStricterPolicies(
			{
				defaults: { "read-only": "allow", write: "ask", destructive: "ask", network: "ask" },
				rules: [{ id: "parent-deny", toolName: "write", subject: "secrets/**", level: "deny" }],
			},
			{
				defaults: { "read-only": "allow", write: "ask", destructive: "ask", network: "ask" },
				rules: [{ id: "child-allow", toolName: "write", subject: "secrets/public/**", level: "allow" }],
			},
		);

		expect(policy.rules).toEqual([
			{ id: "parent-deny", toolName: "write", subject: "secrets/**", level: "deny" },
			{ id: "child-allow", toolName: "write", subject: "secrets/public/**", level: "allow" },
		]);
		expect(decide(policy, "write", "secrets/public/readme.md", { accessLevel: "write" })).toEqual({
			level: "deny",
			ruleId: "parent-deny",
		});
	});

	it("delegates the prompt to the requested profile with stricter inherited policy", async () => {
		const calls: Array<{ profile: string; options: HarnessConfig; prompt: string }> = [];
		let disposeCount = 0;
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig({
				policy: {
					defaults: { network: "ask", write: "deny" },
					tools: { travel_analyze: "ask" },
				},
			}),
			profileResolver: () => childProfile,
			createChildAgent: async (profile, options) => ({
				prompt: async (prompt) => {
					calls.push({ profile: profile.name, options, prompt });
					return assistantMessage("Travel child reply");
				},
				dispose: async () => {
					disposeCount += 1;
				},
			}),
		});

		const result = await tool.execute("call-1", {
			profile: "travel",
			prompt: "Check tomorrow commute",
			max_turns: 3,
		});

		expect(result.content).toEqual([{ type: "text", text: "Travel child reply" }]);
		expect(result.details).toEqual({ profile: "travel", maxTurns: 3, stopReason: "stop" });
		expect(disposeCount).toBe(1);
		expect(calls).toMatchObject([
			{
				profile: "travel",
				prompt: "Check tomorrow commute",
				options: {
					policy: {
						defaults: { "read-only": "allow", write: "deny", destructive: "ask", network: "ask" },
						tools: { travel_analyze: "ask" },
					},
				},
			},
		]);
	});

	it("passes inherited scoped deny rules to the spawned child policy", async () => {
		const calls: HarnessConfig[] = [];
		const profile: AgentProfile = {
			...childProfile,
			policy: {
				defaults: {
					"read-only": "allow",
					write: "allow",
					destructive: "ask",
					network: "allow",
				},
				tools: { travel_analyze: "allow" },
				rules: [{ id: "child-allow", toolName: "write", subject: "secrets/**", level: "allow" }],
			},
		};
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig({
				policy: {
					rules: [{ id: "parent-deny", toolName: "write", subject: "secrets/**", level: "deny" }],
				},
			}),
			profileResolver: () => profile,
			createChildAgent: async (_profile, options) => {
				calls.push(options);
				return {
					prompt: async () => assistantMessage("Scoped child reply"),
					dispose: async () => undefined,
				};
			},
		});

		await tool.execute("call-1", { profile: "travel", prompt: "Check scoped policy" });

		expect(calls[0]?.policy?.rules).toEqual([
			{ id: "parent-deny", toolName: "write", subject: "secrets/**", level: "deny" },
		]);
		expect(calls[0]?.internal?.inheritedPolicy?.rules).toEqual([
			{ id: "parent-deny", toolName: "write", subject: "secrets/**", level: "deny" },
		]);
	});

	it("defaults child max turns to 10", async () => {
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig(),
			profileResolver: () => childProfile,
			createChildAgent: async () => ({
				prompt: async () => assistantMessage("Default turns"),
				dispose: async () => undefined,
			}),
		});

		const result = await tool.execute("call-1", { profile: "travel", prompt: "Use the default" });

		expect(result.details).toEqual({ profile: "travel", maxTurns: 10, stopReason: "stop" });
	});

	it("passes the next spawn depth marker to child options by default", async () => {
		const childOptions: HarnessConfig[] = [];
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig(),
			profileResolver: () => childProfile,
			createChildAgent: async (_profile, options) => {
				childOptions.push(options);
				return {
					prompt: async () => assistantMessage("Depth marker"),
					dispose: async () => undefined,
				};
			},
		});

		await tool.execute("call-1", { profile: "travel", prompt: "Spawn once" });

		expect(childOptions[0]?.internal?.spawnAgentDepth).toBe(1);
	});

	it("passes runtime evidence and lease wiring to child agents", async () => {
		const evidenceGateway = {
			captureCommand: async () => {
				throw new Error("unused");
			},
			captureOutput: async () => {
				throw new Error("unused");
			},
		} as unknown as EvidenceGateway;
		const getActiveLease = () => ({ writeScope: ["src/child"] });
		const childOptions: Array<HarnessConfig & GenericHarnessRuntimeOptions> = [];
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig(),
			evidenceGateway,
			getActiveLease,
			profileResolver: () => childProfile,
			createChildAgent: async (_profile, options) => {
				childOptions.push(options);
				return {
					prompt: async () => assistantMessage("Runtime wiring"),
					dispose: async () => undefined,
				};
			},
		});

		await tool.execute("call-1", { profile: "travel", prompt: "Spawn once" });

		expect(childOptions[0]?.evidenceGateway).toBe(evidenceGateway);
		expect(childOptions[0]?.getActiveLease).toBe(getActiveLease);
	});

	it("passes task contracts to spawned children and scopes their active lease", async () => {
		const calls: Array<{ prompt: string; options: HarnessConfig & GenericHarnessRuntimeOptions }> = [];
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig(),
			profileResolver: () => childProfile,
			createChildAgent: async (_profile, options) => {
				calls.push({ prompt: "", options });
				return {
					prompt: async (prompt) => {
						calls[0] = { prompt, options };
						return assistantMessage("Contract child reply");
					},
					dispose: async () => undefined,
				};
			},
		});

		const result = await tool.execute("call-1", {
			profile: "travel",
			prompt: "Execute the assigned node",
			task_contract: taskContract,
			max_turns: 2,
		});

		expect(calls[0]?.prompt).toContain("TaskContract (authoritative delegation envelope)");
		expect(calls[0]?.prompt).toContain('"rawRequest": "Can you check tomorrow commute?"');
		expect(calls[0]?.options.getActiveLease?.()).toEqual({ writeScope: ["src/child"] });
		expect(result.details).toEqual({
			profile: "travel",
			maxTurns: 2,
			stopReason: "stop",
			taskContractId: "task-contract-1",
			assignedSkill: "travel-planning",
			gateTier: "G1",
			writeScope: ["src/child"],
		});
	});

	it("maps task contract allowedTools to child activeToolNames", async () => {
		const childOptions: HarnessConfig[] = [];
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig({ activeToolNames: ["read", "write", "grep"] }),
			profileResolver: () => childProfile,
			createChildAgent: async (_profile, options) => {
				childOptions.push(options);
				return {
					prompt: async () => assistantMessage("Allowed tools child reply"),
					dispose: async () => undefined,
				};
			},
		});

		await tool.execute("call-1", {
			profile: "travel",
			prompt: "Execute read-only review",
			task_contract: { ...taskContract, allowedTools: ["read", "grep"] },
		});

		expect(childOptions[0]?.activeToolNames).toEqual(["read", "grep"]);
	});

	it("allows read-only task contracts with an empty write scope", async () => {
		const calls: Array<{ options: HarnessConfig & GenericHarnessRuntimeOptions }> = [];
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig(),
			profileResolver: () => childProfile,
			createChildAgent: async (_profile, options) => {
				calls.push({ options });
				return {
					prompt: async () => assistantMessage("Read-only child reply"),
					dispose: async () => undefined,
				};
			},
		});

		await tool.execute("call-1", {
			profile: "travel",
			prompt: "Review only",
			task_contract: { ...taskContract, writeScope: [], allowedTools: ["read", "grep"] },
		});

		expect(calls[0]?.options.getActiveLease?.()).toEqual({ writeScope: [] });
		expect(calls[0]?.options.activeToolNames).toEqual(["read", "grep"]);
	});

	it("does not let task contract write scope exceed an inherited active lease", async () => {
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig(),
			getActiveLease: () => ({ writeScope: ["src/parent"] }),
			profileResolver: () => childProfile,
			createChildAgent: async () => {
				throw new Error("should not create child");
			},
		});

		await expect(
			tool.execute("call-1", {
				profile: "travel",
				prompt: "Execute the assigned node",
				task_contract: { ...taskContract, writeScope: ["src/other"] },
			}),
		).rejects.toThrow("task contract write scope exceeds active lease: src/other");
	});

	it("reads inherited spawn depth from resolved config by default", async () => {
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig({ internal: { spawnAgentDepth: 1 } }),
			profileResolver: () => childProfile,
			createChildAgent: async () => {
				throw new Error("should not create child");
			},
		});

		await expect(tool.execute("call-1", { profile: "travel", prompt: "Nested" })).rejects.toThrow(
			"spawn_agent depth limit exceeded",
		);
	});

	it("hardens inherited policy after child tool registrations resolve", async () => {
		const parentPolicy: PermissionPolicy = {
			defaults: { "read-only": "allow", write: "deny", destructive: "ask", network: "ask" },
		};
		const profile: AgentProfile = {
			name: "child",
			description: "Child",
			systemPrompt: "child",
			tools: [createToolRegistration("travel_write", "write")],
			policy: {
				defaults: { "read-only": "allow", write: "allow", destructive: "ask", network: "ask" },
				tools: { travel_write: "allow" },
			},
		};

		const harness = await createAgent(profile, {
			apiKey: "test-key",
			useDefaultTools: false,
			internal: { inheritedPolicy: parentPolicy },
		});
		const policy = harness.getConfig().policy;
		await harness.dispose();

		expect(policy.tools?.travel_write).toBe("deny");
	});

	it("blocks grandchildren by default", async () => {
		const tool = createSpawnAgentTool({
			config: resolveHarnessConfig(),
			depth: 1,
			profileResolver: () => childProfile,
			createChildAgent: async () => {
				throw new Error("should not create child");
			},
		});

		await expect(tool.execute("call-1", { profile: "travel", prompt: "Nested" })).rejects.toThrow(
			"spawn_agent depth limit exceeded",
		);
	});
});
