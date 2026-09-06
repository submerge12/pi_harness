#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process, { argv as processArgv, stderr, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { createAgent } from "./agents/create-agent.ts";
import { registerBuiltInProfiles } from "./agents/profiles/index.ts";
import { getProfile } from "./agents/registry.ts";
import { loadConfigLayerOverrides } from "./config-file.ts";
import type { HarnessConfig } from "./config.ts";
import { taskContractSchema, type TaskContract } from "./contract/index.ts";
import { listModelProfiles } from "./model-profiles/index.ts";
import {
	createPiRuntimeAdapter,
	normalizedResultSchema,
	type NormalizedResult,
	type PiRuntimeHarness,
} from "./runtime/index.ts";

const DEFAULT_AGENT = "compass-health";

type ReadableInput = AsyncIterable<string | Uint8Array>;
type WritableOutput = Pick<NodeJS.WriteStream, "write">;
type AdapterRunHarness = PiRuntimeHarness & { dispose?(): Promise<void> | void };

export interface AdapterRunHarnessOptions {
	agent: string;
	cwd?: string;
	thinkingLevel?: string;
	modelId?: string;
}

export interface AdapterRunCommandOptions {
	args?: readonly string[];
	stdin?: ReadableInput;
	stdout?: WritableOutput;
	stderr?: WritableOutput;
	createHarness?: (options: AdapterRunHarnessOptions) => Promise<AdapterRunHarness> | AdapterRunHarness;
}

interface ParsedAdapterRunArgs {
	agent: string;
	cwd?: string;
	thinkingLevel?: string;
	modelId?: string;
	taskJson?: string;
	taskFile?: string;
	help: boolean;
}

export async function runAdapterCommand(options: AdapterRunCommandOptions = {}): Promise<number> {
	const args = options.args ?? processArgv.slice(2);
	const out = options.stdout ?? stdout;
	const err = options.stderr ?? stderr;
	const input = options.stdin ?? stdin;
	const createHarness = options.createHarness ?? createAdapterRunHarness;
	let harness: AdapterRunHarness | undefined;

	try {
		const parsed = parseAdapterRunArgs(args);
		if (parsed.help) {
			out.write(`${formatAdapterRunHelp()}\n`);
			return 0;
		}

		const taskContract = parseTaskContract(await readTaskContractInput(parsed, input));
		harness = await createHarness({
			agent: parsed.agent,
			cwd: parsed.cwd,
			thinkingLevel: parsed.thinkingLevel,
			modelId: parsed.modelId,
		});
		const result = await createPiRuntimeAdapter(harness).run(taskContract);
		writeNormalizedResult(out, normalizeRunnerOutput(result));
		return 0;
	} catch (error) {
		writeNormalizedResult(out, failedResult(errorMessage(error)));
		if (err === stderr && process.env.PI_ADAPTER_RUN_DEBUG === "1") {
			err.write(`${error instanceof Error && error.stack ? error.stack : String(error)}\n`);
		}
		return 1;
	} finally {
		await harness?.dispose?.();
	}
}

export async function createAdapterRunHarness(options: AdapterRunHarnessOptions): Promise<AdapterRunHarness> {
	registerBuiltInProfiles();
	const cliConfig: HarnessConfig = {
		agent: options.agent,
		cwd: options.cwd,
		...(options.thinkingLevel !== undefined
			? { thinkingLevel: options.thinkingLevel as HarnessConfig["thinkingLevel"] }
			: {}),
		...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
	};
	const config = await loadConfigLayerOverrides({ cwd: options.cwd, cli: cliConfig });
	const agent = config.agent ?? options.agent;
	const profile = getProfile(agent);
	return await createAgent(profile, { ...config, agent });
}

export function parseAdapterRunArgs(args: readonly string[]): ParsedAdapterRunArgs {
	const parsed: ParsedAdapterRunArgs = {
		agent: DEFAULT_AGENT,
		help: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg.startsWith("--agent=")) {
			parsed.agent = arg.slice("--agent=".length);
			continue;
		}
		if (arg === "--agent") {
			parsed.agent = readOptionValue(args, index, "--agent");
			index++;
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			parsed.cwd = arg.slice("--cwd=".length);
			continue;
		}
		if (arg === "--cwd") {
			parsed.cwd = readOptionValue(args, index, "--cwd");
			index++;
			continue;
		}
		if (arg.startsWith("--thinking=")) {
			parsed.thinkingLevel = arg.slice("--thinking=".length);
			continue;
		}
		if (arg === "--thinking") {
			parsed.thinkingLevel = readOptionValue(args, index, "--thinking");
			index++;
			continue;
		}
		if (arg.startsWith("--model=")) {
			parsed.modelId = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--model") {
			parsed.modelId = readOptionValue(args, index, "--model");
			index++;
			continue;
		}
		if (arg.startsWith("--task-json=")) {
			parsed.taskJson = arg.slice("--task-json=".length);
			continue;
		}
		if (arg === "--task-json" || arg === "--task") {
			parsed.taskJson = readOptionValue(args, index, arg);
			index++;
			continue;
		}
		if (arg.startsWith("--task-file=")) {
			parsed.taskFile = arg.slice("--task-file=".length);
			continue;
		}
		if (arg === "--task-file") {
			parsed.taskFile = readOptionValue(args, index, "--task-file");
			index++;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		if (parsed.taskJson !== undefined) throw new Error("Only one positional TaskContract JSON argument is allowed");
		parsed.taskJson = arg;
	}

	if (parsed.agent.length === 0) throw new Error("--agent requires a value");
	if (parsed.taskJson !== undefined && parsed.taskFile !== undefined) {
		throw new Error("Use only one TaskContract input source");
	}
	return parsed;
}

function readOptionValue(args: readonly string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

function formatAdapterRunHelp(): string {
	return [
		"usage: pi-harness-adapter-run [--agent name] [--cwd path] [--thinking level] [--model id] [--task-json json | --task-file path]",
		"",
		"Reads a TaskContract JSON document from stdin by default and writes a NormalizedResult JSON document to stdout.",
		"Thinking level: off | minimal | low | medium | high | xhigh (per-run override of the agent thinkingLevel).",
		`Model: one of ${listModelProfiles().map((profile) => profile.modelId).join(" | ")} (per-run override of the agent modelId).`,
	].join("\n");
}

async function readTaskContractInput(parsed: ParsedAdapterRunArgs, input: ReadableInput): Promise<string> {
	if (parsed.taskJson !== undefined) return parsed.taskJson;
	if (parsed.taskFile !== undefined) return await readFile(parsed.taskFile, "utf8");
	return await readAll(input);
}

async function readAll(input: ReadableInput): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of input) {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
	}
	return chunks.join("");
}

function parseTaskContract(text: string): TaskContract {
	if (text.trim().length === 0) throw new Error("Invalid TaskContract: no JSON input provided");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid TaskContract JSON: ${errorMessage(error)}`);
	}
	if (!Check(taskContractSchema, parsed)) {
		throw new Error(`Invalid TaskContract: ${formatFirstSchemaError(taskContractSchema, parsed)}`);
	}
	return parsed as TaskContract;
}

function normalizeRunnerOutput(result: NormalizedResult): NormalizedResult {
	if (Check(normalizedResultSchema, result)) return result;
	return failedResult(`PI runtime returned an invalid NormalizedResult: ${formatFirstSchemaError(normalizedResultSchema, result)}`);
}

function failedResult(message: string): NormalizedResult {
	return {
		status: "failed",
		testResults: [],
		evidenceRefs: [],
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
		message,
	};
}

function writeNormalizedResult(out: WritableOutput, result: NormalizedResult): void {
	out.write(`${JSON.stringify(result)}\n`);
}

function formatFirstSchemaError(schema: TSchema, value: unknown): string {
	const [first] = [...Errors(schema, value)] as Array<{ path?: string; instancePath?: string; message?: string }>;
	const path = first?.path ?? first?.instancePath ?? "<root>";
	const message = first?.message ?? "does not match schema";
	return `${path || "<root>"} ${message}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function main(): Promise<void> {
	process.exitCode = await runAdapterCommand();
}

if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
	await main();
}
