import { useCallback, useEffect, useRef, useState } from "react";
import { CostTracker } from "../../observability/cost-tracker.ts";
import type { HarnessEvent } from "../../observability/types.ts";
import {
	executeSlashCommand,
	isSlashCommandLine,
	shouldShowSlashCommandMenu,
	type ReplHarness,
	type SlashCommandMetadata,
} from "../commands.ts";
import { createCliRenderState, reduceCliEvent, type CliRenderState } from "../render-state.ts";
import { finalizeMarkdown } from "./markdown.ts";

export type TuiTranscriptTone = "user" | "assistant" | "system" | "error";

export interface TuiTranscriptItem {
	id: number;
	tone: TuiTranscriptTone;
	text: string;
}

export interface UseHarnessResult {
	busy: boolean;
	input: string;
	renderState: CliRenderState;
	transcript: TuiTranscriptItem[];
	commandMenuOpen: boolean;
	setInput(value: string): void;
	submit(value: string): void;
	completeCommand(command: SlashCommandMetadata): void;
	dismissCommandMenu(): void;
	abortOrExit(): Promise<void>;
	exitNow(): void;
}

function lifecycleClarification(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const record = result as Record<string, unknown>;
	return record.entryStage === "intake" && typeof record.clarification === "string"
		? record.clarification
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface UseHarnessOptions {
	onExit(): void;
}

export function useHarness(harness: ReplHarness, options: UseHarnessOptions): UseHarnessResult {
	const [busy, setBusy] = useState(false);
	const [input, setInput] = useState("");
	const [menuDismissedFor, setMenuDismissedFor] = useState<string | undefined>();
	const [renderState, setRenderState] = useState<CliRenderState>(() => createCliRenderState());
	const [transcript, setTranscript] = useState<TuiTranscriptItem[]>([]);
	const nextIdRef = useRef(1);
	const trackerRef = useRef(new CostTracker());
	const renderStateRef = useRef(renderState);
	const busyRef = useRef(false);

	const pushTranscript = useCallback((tone: TuiTranscriptTone, text: string) => {
		if (!text.trim()) return;
		const id = nextIdRef.current;
		nextIdRef.current++;
		setTranscript((items) => [...items, { id, tone, text }]);
	}, []);

	useEffect(() => {
		const unsubscribe = harness.subscribe?.((event: HarnessEvent) => {
			trackerRef.current.handleEvent(event);
			const previousTranscriptLength = renderStateRef.current.transcript.length;
			const result = reduceCliEvent(renderStateRef.current, event);
			renderStateRef.current = result.state;
			setRenderState(result.state);

			const committed = result.state.transcript.slice(previousTranscriptLength);
			for (const item of committed) pushTranscript("assistant", finalizeMarkdown(item.text));
		});

		return () => {
			unsubscribe?.();
		};
	}, [harness, pushTranscript]);

	const commandMenuOpen = shouldShowSlashCommandMenu(input) && menuDismissedFor !== input;

	const completeCommand = useCallback((command: SlashCommandMetadata) => {
		setInput(`/${command.name} `);
		setMenuDismissedFor(undefined);
	}, []);

	const dismissCommandMenu = useCallback(() => {
		setMenuDismissedFor(input);
	}, [input]);

	const submit = useCallback(
		(value: string) => {
			if (busyRef.current) return;
			const line = value.trim();
			if (!line) return;

			setInput("");
			setMenuDismissedFor(undefined);
			if (isSlashCommandLine(line)) {
				void (async () => {
					try {
						const keepRunning = await executeSlashCommand(harness, trackerRef.current, line, (text) =>
							pushTranscript("system", text.trimEnd()),
						);
						if (!keepRunning) options.onExit();
					} catch (error) {
						pushTranscript("error", `[error] ${errorMessage(error)}`);
					}
				})();
				return;
			}

			pushTranscript("user", `> ${line}`);
			setBusy(true);
			busyRef.current = true;
			void (async () => {
				try {
					const result = await harness.prompt(line);
					const clarification = lifecycleClarification(result);
					if (clarification) pushTranscript("system", clarification);
				} catch (error) {
					pushTranscript("error", `[error] ${errorMessage(error)}`);
				} finally {
					busyRef.current = false;
					setBusy(false);
				}
			})();
		},
		[harness, options, pushTranscript],
	);

	const abortOrExit = useCallback(async () => {
		if (busyRef.current) {
			await harness.abort?.();
			busyRef.current = false;
			setBusy(false);
			return;
		}
		options.onExit();
	}, [harness, options]);

	return {
		busy,
		input,
		renderState,
		transcript,
		commandMenuOpen,
		setInput,
		submit,
		completeCommand,
		dismissCommandMenu,
		abortOrExit,
		exitNow: options.onExit,
	};
}
