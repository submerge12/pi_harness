import type {
	AgentHarnessResources,
	ExecutionEnv,
	JsonlSessionMetadata,
	Session,
} from "@earendil-works/pi-agent-core";
import { createJsonlSession } from "../session/factory.ts";
import type { HarnessConfig, ResolvedHarnessConfig } from "../config.ts";
import { resolveHarnessConfig } from "../config.ts";
import { GenericHarness, createGenericHarnessFromSession } from "../harness.ts";
import { PermissionGate } from "../tools/permission.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolRegistration } from "../tools/types.ts";
import { mergeAgentProfileConfig } from "./merge.ts";
import type { AgentProfile, AgentToolDefinition } from "./profile.ts";

export interface CreateAgentOptions extends HarnessConfig {
	env?: ExecutionEnv;
	session?: Session<JsonlSessionMetadata>;
}

function mergeResources(
	profile: AgentProfile,
	config: ResolvedHarnessConfig,
): AgentHarnessResources | undefined {
	const skills = [...(profile.skills ?? []), ...(config.resources?.skills ?? [])];
	const promptTemplates = [...(profile.templates ?? []), ...(config.resources?.promptTemplates ?? [])];
	if (skills.length === 0 && promptTemplates.length === 0) return config.resources;
	return {
		skills: skills.length > 0 ? skills : undefined,
		promptTemplates: promptTemplates.length > 0 ? promptTemplates : undefined,
	};
}

function isToolRegistrationList(
	value: ToolRegistration | readonly ToolRegistration[],
): value is readonly ToolRegistration[] {
	return Array.isArray(value);
}

async function resolveToolDefinition(
	definition: AgentToolDefinition,
	env: ExecutionEnv,
	config: ResolvedHarnessConfig,
): Promise<readonly ToolRegistration[]> {
	if (typeof definition !== "function") return [definition];
	const result = await definition({ env, config });
	if (isToolRegistrationList(result)) return result;
	return [result];
}

async function createRegistry(
	profile: AgentProfile,
	env: ExecutionEnv,
	config: ResolvedHarnessConfig,
): Promise<ToolRegistry | undefined> {
	if (!profile.tools || profile.tools.length === 0) return undefined;
	const registry = new ToolRegistry();
	for (const definition of profile.tools) {
		const registrations = await resolveToolDefinition(definition, env, config);
		for (const registration of registrations) registry.register(registration);
	}
	return registry;
}

async function createSession(
	config: ResolvedHarnessConfig,
	options: CreateAgentOptions,
): Promise<{ env: ExecutionEnv; session: Session<JsonlSessionMetadata> }> {
	if (options.env && options.session) return { env: options.env, session: options.session };
	if (options.env || options.session) throw new Error("createAgent requires both env and session when either is provided");
	return await createJsonlSession({ cwd: config.cwd, sessionsRoot: config.sessionsRoot });
}

export async function createAgent(profile: AgentProfile, options: CreateAgentOptions = {}): Promise<GenericHarness> {
	const { env: _env, session: _session, ...overrides } = options;
	const mergedConfig = mergeAgentProfileConfig(profile, overrides);
	const resolvedConfig = resolveHarnessConfig(mergedConfig);
	const { env, session } = await createSession(resolvedConfig, options);
	const registry = await createRegistry(profile, env, resolvedConfig);
	const profileTools = registry?.toAgentTools() ?? [];
	const tools = profileTools.length > 0 || resolvedConfig.tools
		? [...profileTools, ...(resolvedConfig.tools ?? [])]
		: undefined;
	const config: HarnessConfig = {
		...resolvedConfig,
		resources: mergeResources(profile, resolvedConfig),
		tools,
		toolRegistrations: registry?.listRegistrations(),
		useDefaultTools: tools === undefined ? resolvedConfig.useDefaultTools : false,
	};
	const harness = await createGenericHarnessFromSession(config, env, session);
	if (registry) {
		harness.addDisposer(
			new PermissionGate(registry, harness.getConfig().policy, {
				askCallback: harness.getConfig().askPermission,
			}).install(harness),
		);
	}
	const disposer = await profile.install?.(harness);
	if (disposer) harness.addDisposer(disposer);
	return harness;
}
