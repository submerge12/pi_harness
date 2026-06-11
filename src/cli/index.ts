#!/usr/bin/env node
import process, { argv as processArgv, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import { createAgent } from "../agents/create-agent.ts";
import { registerBuiltInProfiles } from "../agents/profiles/index.ts";
import { getProfile, listProfiles } from "../agents/registry.ts";
import { loadConfigLayerOverrides } from "../config-file.ts";
import type { HarnessConfig } from "../config.ts";
import { createGenericHarness, createGenericHarnessFromSession, type GenericHarness } from "../harness.ts";
import { CostTracker } from "../observability/cost-tracker.ts";
import type { HarnessEvent } from "../observability/types.ts";
import { listSessions, openJsonlSession } from "../session/factory.ts";
import { createPermissionStore } from "../tools/permission-store.ts";
import { createStoredPermissionCallback, promptForPermission } from "./permission-prompt.ts";
import { CliRenderer } from "./renderer.ts";
import { type ReplHarness, runRepl } from "./repl.ts";

export interface CliOptions {
	cwd?: string;
	agent?: string;
	provider?: string;
	model?: string;
	apiKey?: string;
	continueSession?: boolean;
	listSessions?: boolean;
	resume?: string;
}

export interface ParsedCliArgs {
	options: CliOptions;
	command?: "agents";
	prompt?: string;
	help: boolean;
}

export type CliHarnessFactory = (options: CliOptions) => Promise<ReplHarness> | ReplHarness;

function resolveProvider(provider: string | undefined): KnownProvider | undefined {
	if (!provider) return undefined;
	const knownProviders = getProviders();
	if (knownProviders.includes(provider as KnownProvider)) return provider as KnownProvider;
	throw new Error(`unknown provider: ${provider}`);
}

export function resolveCliHarnessConfig(options: CliOptions): HarnessConfig {
	return {
		cwd: options.cwd,
		agent: options.agent,
		provider: resolveProvider(options.provider),
		modelId: options.model,
		apiKey: options.apiKey,
	};
}

async function loadCliHarnessConfig(options: CliOptions): Promise<HarnessConfig> {
	return await loadConfigLayerOverrides({
		cwd: options.cwd,
		cli: resolveCliHarnessConfig(options),
	});
}

function readValue(args: readonly string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

export function parseCliArgs(args: readonly string[]): ParsedCliArgs {
	const options: CliOptions = {};
	const promptParts: string[] = [];
	let help = false;
	let parsingOptions = true;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (!parsingOptions) {
			promptParts.push(arg);
			continue;
		}
		if (arg === "--") {
			parsingOptions = false;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg.startsWith("--agent=")) {
			options.agent = arg.slice("--agent=".length);
			continue;
		}
		if (arg === "--agent") {
			options.agent = readValue(args, index, "--agent");
			index++;
			continue;
		}
		if (arg === "--continue") {
			options.continueSession = true;
			continue;
		}
		if (arg === "--list-sessions") {
			options.listSessions = true;
			continue;
		}
		if (arg.startsWith("--resume=")) {
			options.resume = arg.slice("--resume=".length);
			continue;
		}
		if (arg === "--resume") {
			options.resume = readValue(args, index, "--resume");
			index++;
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			options.cwd = arg.slice("--cwd=".length);
			continue;
		}
		if (arg === "--cwd") {
			options.cwd = readValue(args, index, "--cwd");
			index++;
			continue;
		}
		if (arg.startsWith("--provider=")) {
			options.provider = arg.slice("--provider=".length);
			continue;
		}
		if (arg === "--provider") {
			options.provider = readValue(args, index, "--provider");
			index++;
			continue;
		}
		if (arg.startsWith("--model=")) {
			options.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--model") {
			options.model = readValue(args, index, "--model");
			index++;
			continue;
		}
		if (arg.startsWith("--api-key=")) {
			options.apiKey = arg.slice("--api-key=".length);
			continue;
		}
		if (arg === "--api-key") {
			options.apiKey = readValue(args, index, "--api-key");
			index++;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		if (arg === "agents" && promptParts.length === 0) {
			return { options, command: "agents", help };
		}
		promptParts.push(arg);
		parsingOptions = false;
	}

	if (options.resume !== undefined && options.resume.length === 0) {
		throw new Error("--resume requires a value");
	}
	if (options.resume !== undefined && options.continueSession) {
		throw new Error("--resume cannot be combined with --continue");
	}

	return { options, prompt: promptParts.length > 0 ? promptParts.join(" ") : undefined, help };
}

export function formatCliHelp(): string {
	return [
		"usage: pi-harness [--agent name] [--cwd path] [--provider name] [--model id] [--api-key key] [--continue|--resume id|--list-sessions] [prompt...]",
		"       pi-harness agents",
		"",
		"commands: /model /cost /cache /sessions /thinking /compact /quit",
	].join("\n");
}

export function formatAgentsList(): string {
	const rows = listProfiles().map((profile) => `${profile.name}\t${profile.description}`);
	return rows.length > 0 ? `${rows.join("\n")}\n` : "";
}

function toReplHarness(
	harness: GenericHarness,
	defaultProvider: string | undefined,
	listSessionsForCwd: () => Promise<readonly ReplSessionInfo[]>,
): ReplHarness {
	return {
		abort: async () => await harness.abort(),
		compact: async (customInstructions?: string) => await harness.compact(customInstructions),
		getCacheReport: () => harness.getCacheReport(),
		getModel: () => harness.getModel(),
		getThinkingLevel: () => harness.getThinkingLevel(),
		listSessions: listSessionsForCwd,
		prompt: async (text: string) => await harness.prompt(text),
		dispose: async () => await harness.dispose(),
		setModel: async (modelReference) => {
			const provider = resolveProvider(modelReference.provider ?? defaultProvider ?? harness.getModel()?.provider);
			if (!provider) throw new Error("provider is required to change models");
			await harness.setModel(provider, modelReference.model);
		},
		setThinkingLevel: async (level) => await harness.setThinkingLevel(level),
		subscribe: (listener) => harness.subscribe((event, signal) => listener(event as HarnessEvent, signal)),
	};
}

export async function createCliHarness(options: CliOptions): Promise<ReplHarness> {
	const config = await loadCliHarnessConfig(options);
	const cwd = config.cwd ?? process.cwd();
	const permissionStore = createPermissionStore({ cwd });
	const configWithPermission: HarnessConfig = {
		...config,
		askPermission: createStoredPermissionCallback({ store: permissionStore }),
	};
	const sessionsForCwd = async (): Promise<readonly ReplSessionInfo[]> =>
		await listSessions({ cwd, sessionsRoot: config.sessionsRoot ?? ".pi-harness/sessions" });
	const sessionId = options.resume ?? (options.continueSession ? (await sessionsForCwd())[0]?.id : undefined);
	if (options.continueSession && !sessionId) throw new Error("no sessions to continue");
	const harness = sessionId
		? await createHarnessFromSession(configWithPermission, sessionId)
		: await createConfiguredHarness(configWithPermission);
	return toReplHarness(harness, options.provider ?? config.provider, sessionsForCwd);
}

async function createConfiguredHarness(config: HarnessConfig): Promise<GenericHarness> {
	if (!config.agent) return await createGenericHarness(config);
	registerBuiltInProfiles();
	return await createAgent(getProfile(config.agent), config);
}

async function createHarnessFromSession(config: HarnessConfig, sessionId: string): Promise<GenericHarness> {
	const cwd = config.cwd ?? process.cwd();
	const sessionsRoot = config.sessionsRoot ?? ".pi-harness/sessions";
	const { env, session } = await openJsonlSession({ cwd, sessionsRoot, sessionId });
	if (!config.agent) return await createGenericHarnessFromSession(config, env, session);
	registerBuiltInProfiles();
	return await createAgent(getProfile(config.agent), { ...config, env, session });
}

export interface ReplSessionInfo {
	id: string;
	createdAt: string;
	cwd: string;
	path: string;
}

async function printSessions(options: CliOptions): Promise<void> {
	const config = await loadCliHarnessConfig(options);
	const sessions = await listSessions({ cwd: config.cwd ?? process.cwd(), sessionsRoot: config.sessionsRoot ?? ".pi-harness/sessions" });
	if (sessions.length === 0) {
		stdout.write("no sessions\n");
		return;
	}
	for (const session of sessions) {
		stdout.write(`${session.id}\t${session.createdAt}\t${session.cwd}\t${session.path}\n`);
	}
}

async function printAgents(): Promise<void> {
	registerBuiltInProfiles();
	stdout.write(formatAgentsList());
}

async function runOneShot(harness: ReplHarness, prompt: string): Promise<void> {
	const tracker = new CostTracker();
	const renderer = new CliRenderer({ output: stdout });
	const unsubscribe = harness.subscribe?.((event: HarnessEvent) => {
		tracker.handleEvent(event);
		renderer.handleEvent(event);
	});
	try {
		await harness.prompt(prompt);
	} finally {
		unsubscribe?.();
	}
}

export async function runCli(
	factory: CliHarnessFactory,
	args: readonly string[] = processArgv.slice(2),
): Promise<void> {
	const parsed = parseCliArgs(args);
	if (parsed.help) {
		stdout.write(`${formatCliHelp()}\n`);
		return;
	}
	if (parsed.command === "agents") {
		await printAgents();
		return;
	}
	if (parsed.options.listSessions) {
		await printSessions(parsed.options);
		return;
	}
	const harness = await factory(parsed.options);
	try {
		if (parsed.prompt) {
			await runOneShot(harness, parsed.prompt);
			return;
		}
		await runRepl(harness);
	} finally {
		await harness.dispose?.();
	}
}

export async function main(factory: CliHarnessFactory): Promise<void> {
	try {
		await runCli(factory);
	} catch (error) {
		stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

export { CostDisplay } from "./cost-display.ts";
export { promptForPermission } from "./permission-prompt.ts";
export { CliRenderer } from "./renderer.ts";
export { runRepl } from "./repl.ts";

if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
	await main(createCliHarness);
}
