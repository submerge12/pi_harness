import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
	PermissionPrompt,
	PermissionPromptDecision,
	PermissionRequest,
} from "../permission-prompt.ts";

interface PendingPermissionRequest {
	request: PermissionRequest;
	resolve(decision: PermissionPromptDecision): void;
}

export interface TuiPermissionSnapshot {
	request?: PermissionRequest;
}

export interface TuiPermissionController {
	getSnapshot(): TuiPermissionSnapshot;
	prompt: PermissionPrompt;
	resolve(decision: PermissionPromptDecision): void;
	subscribe(listener: () => void): () => void;
}

function stringifyArgs(args: unknown): string {
	if (args === undefined) return "{}";
	try {
		return JSON.stringify(args);
	} catch {
		return "\"<unserializable>\"";
	}
}

export function createTuiPermissionController(): TuiPermissionController {
	const listeners = new Set<() => void>();
	const queue: PendingPermissionRequest[] = [];
	let current: PendingPermissionRequest | undefined;

	function emit(): void {
		for (const listener of listeners) listener();
	}

	function pump(): void {
		if (current || queue.length === 0) return;
		current = queue.shift();
		emit();
	}

	return {
		getSnapshot: () => ({ request: current?.request }),
		prompt: async (request) =>
			await new Promise<PermissionPromptDecision>((resolve) => {
				queue.push({ request, resolve });
				pump();
			}),
		resolve(decision) {
			if (!current) return;
			const pending = current;
			current = undefined;
			pending.resolve(decision);
			pump();
			emit();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export interface PermissionPromptViewProps {
	controller: TuiPermissionController;
	onCancel?(): void;
}

export function usePermissionSnapshot(controller: TuiPermissionController): TuiPermissionSnapshot {
	const [snapshot, setSnapshot] = useState<TuiPermissionSnapshot>(() => controller.getSnapshot());

	useEffect(
		() =>
			controller.subscribe(() => {
				setSnapshot(controller.getSnapshot());
			}),
		[controller],
	);

	return snapshot;
}

export function PermissionPromptView({ controller, onCancel }: PermissionPromptViewProps): React.JSX.Element | null {
	const snapshot = usePermissionSnapshot(controller);
	const request = snapshot.request;

	useInput(
		(input, key) => {
			if (!request) return;
			if ((key.ctrl && input === "c") || input === "\u0004") {
				controller.resolve("deny");
				onCancel?.();
				return;
			}
			const normalized = input.toLowerCase();
			if (normalized === "y") controller.resolve("allow");
			if (normalized === "n") controller.resolve("deny");
			if (normalized === "a") controller.resolve("always");
			if (normalized === "d") controller.resolve("never");
		},
		{ isActive: Boolean(request) },
	);

	if (!request) return null;

	return (
		<Box flexDirection="column" borderStyle="single" paddingX={1}>
			<Text color="yellow">Allow tool {request.toolName}?</Text>
			{request.subject ? <Text>subject: {request.subject}</Text> : null}
			<Text>args: {stringifyArgs(request.args)}</Text>
			<Text color="cyan">[y] allow  [n] deny  [a] always  [d] deny-always</Text>
		</Box>
	);
}
