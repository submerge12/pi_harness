import { describe, expect, it } from "vitest";
import {
	classifyModelFailure,
	failureRetryClassification,
} from "../../src/model-adapters/failure-classifier.ts";
import { deepSeekV4ProProfile } from "../../src/model-profiles/index.ts";

describe("model failure classifier", () => {
	it("classifies English and Chinese refusals from the profile signatures", () => {
		expect(classifyModelFailure("I cannot help with that request.", deepSeekV4ProProfile)?.kind).toBe("refusal");
		expect(classifyModelFailure("抱歉，我无法完成这个任务。", deepSeekV4ProProfile)?.kind).toBe("refusal");
	});

	it("classifies degenerate repetition loops for profiles that opt in", () => {
		const phrase = "The next step is to check the configuration file. ";
		expect(classifyModelFailure(phrase.repeat(8), deepSeekV4ProProfile)?.kind).toBe("loop");
	});

	it("does not classify repetitive output as a loop unless the profile opts in", () => {
		// Legitimate repetitive output (table rows, log lines) must not be a fatal loop by default.
		const tableRow = "| region-a | 42 | 42 | 42 | ok |\n";
		const optedOut = { failureSignatures: { refusal: [], loop: [], truncation: [] } };
		expect(classifyModelFailure(tableRow.repeat(20), optedOut)).toBeUndefined();
	});

	it("bounds loop detection on long non-repeating output", () => {
		const text = Array.from({ length: 50_000 }, (_, index) => `token-${index}`).join(" ");
		const startedAt = performance.now();

		expect(classifyModelFailure(text, deepSeekV4ProProfile)).toBeUndefined();
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});

	it("classifies an unterminated JSON fence as truncation", () => {
		const text = 'Here is the result:\n```json\n{"status": "compl';
		expect(classifyModelFailure(text, deepSeekV4ProProfile)?.kind).toBe("truncation");
	});

	it("returns undefined for healthy output", () => {
		const text = 'Done. Summary:\n```json\n{"status": "completed"}\n```\nAll tests pass.';
		expect(classifyModelFailure(text, deepSeekV4ProProfile)).toBeUndefined();
	});

	it("maps failure kinds onto the retry policy", () => {
		expect(failureRetryClassification("refusal")).toBe("fatal");
		expect(failureRetryClassification("loop")).toBe("fatal");
		expect(failureRetryClassification("truncation")).toBe("transient");
	});
});
