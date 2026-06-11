import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { PermissionStore } from "../tools/permission-store.ts";
import type { AskPermissionCallback } from "../tools/types.ts";

export interface PermissionRequest {
	toolName: string;
	args?: unknown;
}

export type PermissionPromptDecision = "allow" | "deny" | "always" | "never";

export interface PermissionPromptOptions {
	input?: Readable;
	output?: Writable;
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionPromptDecision>;

export interface StoredPermissionCallbackOptions {
	prompt?: PermissionPrompt;
	store: PermissionStore;
}

function stringifyArgs(args: unknown): string {
	if (args === undefined) return "{}";
	try {
		return JSON.stringify(args);
	} catch {
		return '"<unserializable>"';
	}
}

export function parsePermissionPromptAnswer(answer: string): PermissionPromptDecision {
	const normalized = answer.trim().toLowerCase();
	if (normalized === "y" || normalized === "yes") return "allow";
	if (normalized === "a" || normalized === "always") return "always";
	if (normalized === "d" || normalized === "never") return "never";
	return "deny";
}

export async function promptForPermissionDecision(
	request: PermissionRequest,
	options: PermissionPromptOptions = {},
): Promise<PermissionPromptDecision> {
	const input = options.input ?? defaultInput;
	const output = options.output ?? defaultOutput;
	output.write(`Allow tool ${request.toolName}?\n`);
	output.write(`args: ${stringifyArgs(request.args)}\n`);
	const readline = createInterface({ input, output });
	try {
		const answer = await readline.question("allow? [y/N/a/d] ");
		return parsePermissionPromptAnswer(answer);
	} finally {
		readline.close();
	}
}

export async function promptForPermission(
	request: PermissionRequest,
	options: PermissionPromptOptions = {},
): Promise<boolean> {
	const decision = await promptForPermissionDecision(request, options);
	return decision === "allow" || decision === "always";
}

export function createStoredPermissionCallback(options: StoredPermissionCallbackOptions): AskPermissionCallback {
	const prompt = options.prompt ?? ((request) => promptForPermissionDecision(request));
	return async (toolName, args) => {
		if (options.store.isSessionAllowed(toolName)) return true;

		const stored = await options.store.getToolPermission(toolName);
		if (stored === "allow") return true;
		if (stored === "deny") return false;

		const decision = await prompt({ toolName, args });
		if (decision === "allow") {
			options.store.allowForSession(toolName);
			return true;
		}
		if (decision === "always") {
			await options.store.setToolPermission(toolName, "allow");
			return true;
		}
		if (decision === "never") {
			await options.store.setToolPermission(toolName, "deny");
			return false;
		}
		return false;
	};
}
