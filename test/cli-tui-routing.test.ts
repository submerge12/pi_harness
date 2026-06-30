import { describe, expect, test } from "vitest";
import { formatCliHelp, parseCliArgs, shouldUseTui } from "../src/cli/index.ts";

describe("CLI TUI routing", () => {
	test("parses and documents the classic fallback flag", () => {
		expect(parseCliArgs(["--classic", "--agent", "coding"])).toEqual({
			options: { classic: true, agent: "coding" },
			help: false,
		});
		expect(formatCliHelp()).toContain("--classic");
	});

	test("uses the TUI only for interactive terminals that have not opted out", () => {
		const ttyInput = { isTTY: true };
		const ttyOutput = { isTTY: true };

		expect(shouldUseTui({}, {}, ttyInput, ttyOutput)).toBe(true);
		expect(shouldUseTui({ classic: true }, {}, ttyInput, ttyOutput)).toBe(false);
		expect(shouldUseTui({}, { PI_HARNESS_TUI: "0" }, ttyInput, ttyOutput)).toBe(false);
		expect(shouldUseTui({}, {}, { isTTY: false }, ttyOutput)).toBe(false);
		expect(shouldUseTui({}, {}, ttyInput, { isTTY: false })).toBe(false);
	});
});
