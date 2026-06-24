import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileDomainSessionStore } from "../../src/session/domain-session.ts";

describe("DomainSession", () => {
	it("persists decisions and unresolved questions across runs in a conversation", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "pi-domain-session-"));
		const first = createFileDomainSessionStore({ rootDir });

		await first.update("conversation-1", (session) => ({
			...session,
			activeGoal: "ship pi executor",
			decisions: [...session.decisions, { id: "d1", text: "Use PI as executor seam", madeAt: 1 }],
			unresolved: [...session.unresolved, { id: "q1", text: "Who owns AOH registry?", askedAt: 1 }],
			artifactRefs: [...session.artifactRefs, "evidence/run-1/manifest.json"],
		}));

		const second = createFileDomainSessionStore({ rootDir });
		const session = await second.get("conversation-1");

		expect(session.activeGoal).toBe("ship pi executor");
		expect(session.decisions.map((decision) => decision.text)).toEqual(["Use PI as executor seam"]);
		expect(session.unresolved.map((question) => question.text)).toEqual(["Who owns AOH registry?"]);
		expect(session.artifactRefs).toEqual(["evidence/run-1/manifest.json"]);
	});
});
