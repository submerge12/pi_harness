import React from "react";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { render } from "ink-testing-library";
import { finalizeMarkdown } from "../src/cli/tui/markdown.ts";
import {
	createTuiPermissionController,
	PermissionPromptView,
} from "../src/cli/tui/permission.tsx";

describe("TUI markdown rendering", () => {
	test("finalizeMarkdown renders markdown syntax to terminal text", () => {
		const rendered = finalizeMarkdown("## Title\n\n- **bold** item");

		expect(rendered).toContain("Title");
		expect(rendered).toContain("bold");
		expect(rendered).not.toContain("**bold**");
	});
});

describe("TUI permission prompt", () => {
	test("renders a pending permission request and resolves it through the controller", async () => {
		const controller = createTuiPermissionController();
		const instance = render(<PermissionPromptView controller={controller} />);
		const decision = controller.prompt({ toolName: "write", args: { path: "notes.txt" } });
		await delay(0);

		expect(instance.lastFrame()).toContain("Allow tool write?");

		controller.resolve("always");

		await expect(decision).resolves.toBe("always");
	});
});
