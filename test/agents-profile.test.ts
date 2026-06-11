import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Object as TypeObject } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatAgentsList, parseCliArgs, resolveCliHarnessConfig, runCli } from "../src/cli/index.ts";
import { loadConfigLayerOverrides } from "../src/config-file.ts";
import { createAgent } from "../src/agents/create-agent.ts";
import { mergeAgentProfileConfig } from "../src/agents/merge.ts";
import {
	clearProfilesForTests,
	getProfile,
	listProfiles,
	registerProfile,
} from "../src/agents/registry.ts";
import type { AgentProfile } from "../src/agents/profile.ts";
import type { ToolRegistration } from "../src/tools/types.ts";

function createProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		name: "coding",
		description: "Coding agent",
		systemPrompt: "profile prompt",
		model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
		thinkingLevel: "high",
		policy: {
			defaults: {
				"read-only": "allow",
				write: "ask",
				destructive: "ask",
				network: "deny",
			},
			tools: { profile_tool: "allow" },
		},
		...overrides,
	};
}

function createToolRegistration(name: string): ToolRegistration {
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
		accessLevel: "read-only",
	};
}

afterEach(() => {
	clearProfilesForTests();
});

describe("agent profile merging", () => {
	it("merges profile defaults under config and CLI overrides", () => {
		const result = mergeAgentProfileConfig(createProfile(), {
			provider: "openai",
			modelId: "cli-model",
			thinkingLevel: "medium",
			systemPrompt: "project prompt",
			policy: {
				defaults: { network: "ask" },
				tools: { profile_tool: "deny" },
			},
		});

		expect(result.provider).toBe("openai");
		expect(result.modelId).toBe("cli-model");
		expect(result.thinkingLevel).toBe("medium");
		expect(result.systemPrompt).toBe("profile prompt\n\nproject prompt");
		expect(result.policy).toEqual({
			defaults: {
				"read-only": "allow",
				write: "ask",
				destructive: "ask",
				network: "ask",
			},
			tools: { profile_tool: "deny" },
		});
	});

	it("applies per-agent config overrides before CLI flags", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-harness-agent-config-"));
		const homeDir = await mkdtemp(join(tmpdir(), "pi-harness-agent-home-"));
		const projectConfigPath = join(cwd, "pi-harness.json");
		await writeFile(
			projectConfigPath,
			JSON.stringify({
				agent: "coding",
				provider: "deepseek",
				modelId: "general-model",
				agents: {
					coding: {
						modelId: "agent-model",
						thinkingLevel: "high",
					},
					research: {
						modelId: "research-model",
					},
				},
			}),
			"utf8",
		);

		const config = await loadConfigLayerOverrides({
			cwd,
			homeDir,
			projectConfigPath,
			cli: resolveCliHarnessConfig({ agent: "research", model: "cli-model" }),
		});

		expect(config.agent).toBe("research");
		expect(config.modelId).toBe("cli-model");
		expect(config.thinkingLevel).toBeUndefined();
	});

	it("rejects per-agent overrides that try to switch the selected agent", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-harness-agent-config-"));
		const homeDir = await mkdtemp(join(tmpdir(), "pi-harness-agent-home-"));
		const projectConfigPath = join(cwd, "pi-harness.json");
		await writeFile(
			projectConfigPath,
			JSON.stringify({
				agent: "coding",
				agents: {
					coding: {
						agent: "research",
					},
				},
			}),
			"utf8",
		);

		await expect(loadConfigLayerOverrides({ cwd, homeDir, projectConfigPath })).rejects.toThrow(
			"project config contains unknown key agents.coding.agent",
		);
	});

	it("keeps profile defaults above generic defaults while still allowing explicit CLI overrides", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-harness-agent-defaults-"));
		const profile = createProfile({
			thinkingLevel: "high",
			policy: {
				defaults: {
					"read-only": "allow",
					write: "deny",
					destructive: "deny",
					network: "deny",
				},
			},
		});

		const harness = await createAgent(profile, {
			cwd,
			apiKey: "test-key",
			...resolveCliHarnessConfig({ agent: "coding" }),
		});
		const config = harness.getConfig();
		await harness.dispose();

		expect(config.thinkingLevel).toBe("high");
		expect(config.policy.defaults.write).toBe("deny");
		expect(config.policy.defaults.network).toBe("deny");
	});
});

describe("agent registry", () => {
	it("registers profiles by name and rejects duplicates", () => {
		const profile = createProfile();

		registerProfile(profile);

		expect(getProfile("coding")).toBe(profile);
		expect(listProfiles()).toEqual([{ name: "coding", description: "Coding agent" }]);
		expect(() => registerProfile(createProfile({ description: "Duplicate" }))).toThrow(
			"Duplicate agent profile: coding",
		);
	});
});

describe("createAgent", () => {
	it("installs profile hooks last and disposes them once", async () => {
		const calls: string[] = [];
		const profile = createProfile({
			install: () => {
				calls.push("install");
				return () => {
					calls.push("dispose");
				};
			},
		});

		const harness = await createAgent(profile, {
			cwd: await mkdtemp(join(tmpdir(), "pi-harness-agent-")),
			apiKey: "test-key",
		});
		calls.push("after-create");
		await harness.dispose();
		await harness.dispose();

		expect(calls).toEqual(["install", "after-create", "dispose"]);
	});

	it("passes static and factory tool registrations into the harness config", async () => {
		const staticTool = createToolRegistration("static_tool");
		const factoryTool = createToolRegistration("factory_tool");
		const profile = createProfile({
			tools: [staticTool, () => factoryTool],
		});

		const harness = await createAgent(profile, {
			cwd: await mkdtemp(join(tmpdir(), "pi-harness-agent-tools-")),
			apiKey: "test-key",
			useDefaultTools: false,
		});
		const toolNames = harness.getConfig().toolRegistrations?.map((registration) => registration.tool.name);
		await harness.dispose();

		expect(toolNames).toEqual(["static_tool", "factory_tool"]);
	});
});

describe("agent CLI", () => {
	it("parses --agent and the agents list command", () => {
		expect(parseCliArgs(["--agent", "coding", "fix", "tests"])).toEqual({
			options: { agent: "coding" },
			prompt: "fix tests",
			help: false,
		});
		expect(parseCliArgs(["agents"])).toEqual({
			options: {},
			command: "agents",
			help: false,
		});
		expect(resolveCliHarnessConfig({ agent: "coding" })).toEqual({
			agent: "coding",
			cwd: undefined,
			provider: undefined,
			modelId: undefined,
			apiKey: undefined,
		});
	});

	it("formats registered agents for list output", () => {
		registerProfile(createProfile());
		registerProfile(createProfile({ name: "research", description: "Research agent" }));

		expect(formatAgentsList()).toBe("coding\tCoding agent\nresearch\tResearch agent\n");
	});

	it("disposes the CLI harness after one-shot prompts", async () => {
		const calls: string[] = [];
		await runCli(
			() => ({
				prompt: async (text: string) => {
					calls.push(`prompt:${text}`);
				},
				dispose: async () => {
					calls.push("dispose");
				},
			}),
			["hello"],
		);

		expect(calls).toEqual(["prompt:hello", "dispose"]);
	});
});
