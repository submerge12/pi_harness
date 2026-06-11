import process, { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { CostTracker } from "../observability/cost-tracker.ts";
import { formatSessionCost } from "../observability/formatter.ts";
import type { HarnessEvent } from "../observability/types.ts";
import { CliRenderer } from "./renderer.ts";
import { createReplSigintController, installReplSigintHandler } from "./signals.ts";

export type ReplThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ReplModelReference {
	provider?: string;
	model: string;
}

export interface ReplSessionInfo {
	id: string;
	createdAt: string;
	cwd: string;
	path: string;
}

export interface ReplHarness {
	prompt(text: string): Promise<unknown>;
	subscribe?(listener: (event: HarnessEvent, signal?: AbortSignal) => Promise<void> | void): () => void;
	abort?(): Promise<unknown>;
	getModel?(): unknown;
	setModel?(model: ReplModelReference): Promise<void> | void;
	getThinkingLevel?(): string | undefined;
	setThinkingLevel?(level: ReplThinkingLevel): Promise<void> | void;
	compact?(customInstructions?: string): Promise<unknown>;
	getCacheReport?(): string;
	listSessions?(): Promise<readonly ReplSessionInfo[]> | readonly ReplSessionInfo[];
	dispose?(): Promise<void> | void;
}

export interface ReplOptions {
	input?: Readable;
	output?: Writable;
	promptLabel?: string;
}

function isThinkingLevel(value: string): value is ReplThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatModel(model: unknown): string {
	if (!model || typeof model !== "object") return String(model ?? "unknown");
	const record = model as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider : undefined;
	const id = typeof record.id === "string" ? record.id : typeof record.model === "string" ? record.model : "unknown";
	return provider ? `${provider}/${id}` : id;
}

function parseModelReference(args: string[]): ReplModelReference | undefined {
	const firstArg = args[0];
	if (!firstArg) return undefined;
	if (args.length === 1) {
		const [provider, ...modelParts] = firstArg.split("/");
		if (provider && modelParts.length > 0) return { provider, model: modelParts.join("/") };
		return { model: firstArg };
	}
	return { provider: firstArg, model: args.slice(1).join(" ") };
}

async function handleCommand(
	harness: ReplHarness,
	tracker: CostTracker,
	line: string,
	output: Writable,
): Promise<boolean> {
	const [command = "", ...args] = line.slice(1).trim().split(/\s+/).filter(Boolean);
	if (command === "quit" || command === "q" || command === "exit") return false;
	if (command === "cost") {
		output.write(`${formatSessionCost(tracker.getSummary())}\n`);
		return true;
	}
	if (command === "model") {
		if (args.length === 0) {
			output.write(`model: ${formatModel(harness.getModel?.())}\n`);
			return true;
		}
		if (!harness.setModel) {
			output.write("model changes unsupported\n");
			return true;
		}
		const model = parseModelReference(args);
		if (!model) {
			output.write("model requires a value\n");
			return true;
		}
		await harness.setModel(model);
		output.write(`model: ${formatModel(model)}\n`);
		return true;
	}
	if (command === "thinking") {
		if (args.length === 0) {
			output.write(`thinking: ${harness.getThinkingLevel?.() ?? "unknown"}\n`);
			return true;
		}
		const level = args[0];
		if (!level) {
			output.write("thinking requires a value\n");
			return true;
		}
		if (!isThinkingLevel(level)) {
			output.write("thinking must be off|minimal|low|medium|high|xhigh\n");
			return true;
		}
		if (!harness.setThinkingLevel) {
			output.write("thinking changes unsupported\n");
			return true;
		}
		await harness.setThinkingLevel(level);
		output.write(`thinking: ${level}\n`);
		return true;
	}
	if (command === "compact") {
		if (!harness.compact) {
			output.write("compaction unsupported\n");
			return true;
		}
		await harness.compact(args.join(" ") || undefined);
		output.write("compacted\n");
		return true;
	}
	if (command === "cache") {
		output.write(`${harness.getCacheReport?.() ?? "cache report unsupported"}\n`);
		return true;
	}
	if (command === "sessions") {
		if (!harness.listSessions) {
			output.write("sessions unsupported\n");
			return true;
		}
		const sessions = await harness.listSessions();
		if (sessions.length === 0) {
			output.write("no sessions\n");
			return true;
		}
		for (const session of sessions) {
			output.write(`${session.id}\t${session.createdAt}\t${session.cwd}\t${session.path}\n`);
		}
		return true;
	}
	output.write(`unknown command: /${command}\n`);
	return true;
}

export async function runRepl(harness: ReplHarness, options: ReplOptions = {}): Promise<void> {
	const input = options.input ?? defaultInput;
	const output = options.output ?? defaultOutput;
	const tracker = new CostTracker();
	const renderer = new CliRenderer({ output });
	const unsubscribe = harness.subscribe?.((event) => {
		tracker.handleEvent(event);
		renderer.handleEvent(event);
	});
	const readline = createInterface({ input, output });
	let keepRunning = true;
	const sigintController = createReplSigintController({
		harness,
		onExit: () => {
			keepRunning = false;
			readline.close();
		},
	});
	const uninstallSigint = installReplSigintHandler(process, sigintController);
	try {
		while (keepRunning) {
			let line: string;
			try {
				line = await readline.question(options.promptLabel ?? "> ");
			} catch (error) {
				if (!keepRunning) break;
				throw error;
			}
			if (!line.trim()) continue;
			try {
				if (line.startsWith("/")) {
					keepRunning = await handleCommand(harness, tracker, line, output);
				} else {
					sigintController.setTurnActive(true);
					try {
						await harness.prompt(line);
					} finally {
						sigintController.setTurnActive(false);
					}
				}
			} catch (error) {
				output.write(`[error] ${errorMessage(error)}\n`);
			}
		}
	} finally {
		uninstallSigint();
		unsubscribe?.();
		readline.close();
	}
}
