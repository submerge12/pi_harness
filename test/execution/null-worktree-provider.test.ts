import { describe, expect, it } from "vitest";
import { createNullWorktreeProvider } from "../../src/execution/index.ts";

describe("createNullWorktreeProvider", () => {
	it("returns a logical lease without running git", async () => {
		const provider = createNullWorktreeProvider({ dir: "logical-agent" });

		const lease = await provider.acquire("ignored-baseline", ["src/execution"]);
		await expect(lease.dispose()).resolves.toBeUndefined();

		expect(lease).toEqual({
			dir: "logical-agent",
			writeScope: ["src/execution"],
			dispose: lease.dispose,
		});
	});

	it("applies the same write-scope validation as git worktrees", async () => {
		const provider = createNullWorktreeProvider({ dir: "logical-agent" });

		await expect(provider.acquire("ignored-baseline", [])).rejects.toThrow("write scope must include at least one path");
	});
});
