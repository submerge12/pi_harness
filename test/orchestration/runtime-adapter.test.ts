import { describe, expect, it } from "vitest";
import { createAgentRuntimeAdapter } from "../../src/orchestration/index.ts";

describe("createAgentRuntimeAdapter", () => {
	it("keeps the orchestration export wired to the PI executor adapter", () => {
		const adapter = createAgentRuntimeAdapter({
			getConfig: () => ({ activeToolNames: ["read"], thinkingLevel: "off" }),
			runRequest: async () => {
				throw new Error("not needed");
			},
		});

		expect(adapter.id).toBe("pi");
		expect(adapter.capabilities()).toMatchObject({ canEdit: false, canRunCommands: false, canNetwork: false });
	});
});
