import process, { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { CostTracker } from "../observability/cost-tracker.ts";
import { executeSlashCommand, isSlashCommandLine, type ReplHarness } from "./commands.ts";
import { CliRenderer } from "./renderer.ts";
import { createReplSigintController, installReplSigintHandler } from "./signals.ts";

export type { ReplHarness } from "./commands.ts";

export interface ReplOptions {
	input?: Readable;
	output?: Writable;
	promptLabel?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lifecycleClarification(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const record = result as Record<string, unknown>;
	return record.entryStage === "intake" && typeof record.clarification === "string"
		? record.clarification
		: undefined;
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
				if (isSlashCommandLine(line)) {
					keepRunning = await executeSlashCommand(harness, tracker, line, output);
				} else {
					sigintController.setTurnActive(true);
					try {
						const result = await harness.prompt(line);
						const clarification = lifecycleClarification(result);
						if (clarification) output.write(`${clarification}\n`);
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
