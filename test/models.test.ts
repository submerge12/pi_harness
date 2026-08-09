import { describe, expect, it } from "vitest";
import { createHarnessModels } from "../src/models.ts";

describe("harness models", () => {
	it("registers built-in models and supplies an explicit API key through provider auth", async () => {
		const models = createHarnessModels({
			provider: "deepseek",
			apiKey: "test-explicit-key",
		});

		expect(models.getModel("deepseek", "deepseek-v4-pro")?.id).toBe("deepseek-v4-pro");
		expect(await models.getAuth("deepseek")).toMatchObject({
			auth: { apiKey: "test-explicit-key" },
		});
	});
});
