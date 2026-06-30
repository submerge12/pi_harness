import { describe, expect, it } from "vitest";
import {
	SLASH_COMMANDS,
	executeSlashCommand,
	filterSlashCommands,
	isSlashCommandLine,
	shouldShowSlashCommandMenu,
	type ReplHarness,
} from "../src/cli/commands.ts";
import { CostTracker } from "../src/observability/cost-tracker.ts";

describe("CLI slash commands", () => {
	it("exposes shared command metadata with aliases, usage, and descriptions", () => {
		expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
			"model",
			"cost",
			"cache",
			"sessions",
			"thinking",
			"compact",
			"quit",
		]);
		expect(SLASH_COMMANDS.every((command) => command.usage.startsWith(`/${command.name}`))).toBe(true);
		expect(SLASH_COMMANDS.every((command) => command.description.length > 0)).toBe(true);
		expect(SLASH_COMMANDS.find((command) => command.name === "quit")?.aliases).toEqual(["q", "exit"]);
	});

	it("shows the menu for slash-word buffers and filters by typed prefix", () => {
		expect(shouldShowSlashCommandMenu("/")).toBe(true);
		expect(shouldShowSlashCommandMenu("/thi")).toBe(true);
		expect(shouldShowSlashCommandMenu("/thinking now")).toBe(false);
		expect(shouldShowSlashCommandMenu(" /")).toBe(false);
		expect(shouldShowSlashCommandMenu("/model-")).toBe(false);

		expect(filterSlashCommands("/").map((command) => command.name)).toEqual(SLASH_COMMANDS.map((command) => command.name));
		expect(filterSlashCommands("/th").map((command) => command.name)).toEqual(["thinking"]);
		expect(filterSlashCommands("/q").map((command) => command.name)).toEqual(["quit"]);
		expect(filterSlashCommands("/unknown")).toEqual([]);
	});

	it("classifies only slash-word lines as commands", () => {
		expect(isSlashCommandLine("/cost")).toBe(true);
		expect(isSlashCommandLine("/model gpt-5")).toBe(true);
		expect(isSlashCommandLine("/compact keep the plan")).toBe(true);
		expect(isSlashCommandLine(" /cost ")).toBe(true);
		expect(isSlashCommandLine("/bogus")).toBe(false);
		expect(isSlashCommandLine("/explain this")).toBe(false);
		expect(isSlashCommandLine("/")).toBe(false);
	});

	it("executes model changes through an injectable harness and output writer", async () => {
		let selectedModel: unknown;
		const harness: ReplHarness = {
			prompt: async () => undefined,
			setModel: async (model) => {
				selectedModel = model;
			},
		};
		let output = "";

		const keepRunning = await executeSlashCommand(harness, new CostTracker(), "/model openai gpt-5.1", (text) => {
			output += text;
		});

		expect(keepRunning).toBe(true);
		expect(selectedModel).toEqual({ provider: "openai", model: "gpt-5.1" });
		expect(output).toBe("model: openai/gpt-5.1\n");
	});

	it("returns false for quit aliases and preserves unknown-command output", async () => {
		const harness: ReplHarness = { prompt: async () => undefined };
		let output = "";

		await expect(executeSlashCommand(harness, new CostTracker(), "/q", (text) => (output += text))).resolves.toBe(false);
		await expect(executeSlashCommand(harness, new CostTracker(), "/bogus", (text) => (output += text))).resolves.toBe(true);

		expect(output).toBe("unknown command: /bogus\n");
	});
});
