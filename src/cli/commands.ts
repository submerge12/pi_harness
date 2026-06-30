import type { Writable } from "node:stream";
import type { CostTracker } from "../observability/cost-tracker.ts";
import { formatSessionCost } from "../observability/formatter.ts";
import type { HarnessEvent } from "../observability/types.ts";

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

export interface SlashCommandMetadata {
	name: string;
	aliases: readonly string[];
	usage: string;
	description: string;
}

export type SlashCommandOutput = Writable | ((text: string) => void);

export const SLASH_COMMANDS = [
	{
		name: "model",
		aliases: [],
		usage: "/model [provider/model | provider model]",
		description: "Show or change the active model.",
	},
	{
		name: "cost",
		aliases: [],
		usage: "/cost",
		description: "Show the current session cost summary.",
	},
	{
		name: "cache",
		aliases: [],
		usage: "/cache",
		description: "Show the cache report for the current session.",
	},
	{
		name: "sessions",
		aliases: [],
		usage: "/sessions",
		description: "List saved sessions for the current workspace.",
	},
	{
		name: "thinking",
		aliases: [],
		usage: "/thinking [off|minimal|low|medium|high|xhigh]",
		description: "Show or change the active thinking level.",
	},
	{
		name: "compact",
		aliases: [],
		usage: "/compact [instructions]",
		description: "Compact the current conversation context.",
	},
	{
		name: "quit",
		aliases: ["q", "exit"],
		usage: "/quit",
		description: "Exit the REPL.",
	},
] as const satisfies readonly SlashCommandMetadata[];

export function shouldShowSlashCommandMenu(buffer: string): boolean {
	return /^\/\w*$/.test(buffer);
}

export function isSlashCommandLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith("/")) return false;
	const commandName = trimmed.slice(1).split(/\s+/)[0];
	if (!commandName) return false;
	return SLASH_COMMANDS.some(
		(command) => command.name === commandName || (command.aliases as readonly string[]).includes(commandName),
	);
}

export function filterSlashCommands(buffer: string): readonly SlashCommandMetadata[] {
	if (!shouldShowSlashCommandMenu(buffer)) return [];
	const prefix = buffer.slice(1);
	return SLASH_COMMANDS.filter((command) => {
		if (command.name.startsWith(prefix)) return true;
		return command.aliases.some((alias) => alias.startsWith(prefix));
	});
}

function writeOutput(output: SlashCommandOutput, text: string): void {
	if (typeof output === "function") {
		output(text);
		return;
	}
	output.write(text);
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

export async function executeSlashCommand(
	harness: ReplHarness,
	tracker: CostTracker,
	line: string,
	output: SlashCommandOutput,
): Promise<boolean> {
	const [command = "", ...args] = line.slice(1).trim().split(/\s+/).filter(Boolean);
	if (command === "quit" || command === "q" || command === "exit") return false;
	if (command === "cost") {
		writeOutput(output, `${formatSessionCost(tracker.getSummary())}\n`);
		return true;
	}
	if (command === "model") {
		if (args.length === 0) {
			writeOutput(output, `model: ${formatModel(harness.getModel?.())}\n`);
			return true;
		}
		if (!harness.setModel) {
			writeOutput(output, "model changes unsupported\n");
			return true;
		}
		const model = parseModelReference(args);
		if (!model) {
			writeOutput(output, "model requires a value\n");
			return true;
		}
		await harness.setModel(model);
		writeOutput(output, `model: ${formatModel(model)}\n`);
		return true;
	}
	if (command === "thinking") {
		if (args.length === 0) {
			writeOutput(output, `thinking: ${harness.getThinkingLevel?.() ?? "unknown"}\n`);
			return true;
		}
		const level = args[0];
		if (!level) {
			writeOutput(output, "thinking requires a value\n");
			return true;
		}
		if (!isThinkingLevel(level)) {
			writeOutput(output, "thinking must be off|minimal|low|medium|high|xhigh\n");
			return true;
		}
		if (!harness.setThinkingLevel) {
			writeOutput(output, "thinking changes unsupported\n");
			return true;
		}
		await harness.setThinkingLevel(level);
		writeOutput(output, `thinking: ${level}\n`);
		return true;
	}
	if (command === "compact") {
		if (!harness.compact) {
			writeOutput(output, "compaction unsupported\n");
			return true;
		}
		await harness.compact(args.join(" ") || undefined);
		writeOutput(output, "compacted\n");
		return true;
	}
	if (command === "cache") {
		writeOutput(output, `${harness.getCacheReport?.() ?? "cache report unsupported"}\n`);
		return true;
	}
	if (command === "sessions") {
		if (!harness.listSessions) {
			writeOutput(output, "sessions unsupported\n");
			return true;
		}
		const sessions = await harness.listSessions();
		if (sessions.length === 0) {
			writeOutput(output, "no sessions\n");
			return true;
		}
		for (const session of sessions) {
			writeOutput(output, `${session.id}\t${session.createdAt}\t${session.cwd}\t${session.path}\n`);
		}
		return true;
	}
	writeOutput(output, `unknown command: /${command}\n`);
	return true;
}
