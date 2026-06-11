import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-agent-core";

export const fixTestsSkill: Skill = {
	name: "fix-tests",
	description: "Run a failing focused test, diagnose the root cause, patch it, and rerun the same test.",
	content: `
Fix a failing test with a disciplined loop.

Run the focused command, read the complete failure, identify the root cause, make the smallest relevant change,
and rerun the same command. Do not broaden the fix until the focused failure is understood.
`.trim(),
	filePath: fileURLToPath(new URL("./fix-tests.ts", import.meta.url)),
};
