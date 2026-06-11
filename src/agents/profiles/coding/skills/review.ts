import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-agent-core";

export const reviewSkill: Skill = {
	name: "review",
	description: "Review a diff for correctness, regression risk, missing tests, and policy violations.",
	content: `
Review the current change as a code reviewer.

Focus on bugs, behavioral regressions, security or permission risks, and missing tests.
Lead with findings ordered by severity and reference concrete files or commands.
If no issues are found, say so and name any residual test gap.
`.trim(),
	filePath: fileURLToPath(new URL("./review.ts", import.meta.url)),
};
