import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	extractDefaultMemoryCandidates,
	InMemoryUserMemoryStore,
	recallUserMemories,
	writeUserMemory,
} from "../../src/memory/index.ts";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("extractDefaultMemoryCandidates", () => {
	it("marks user-stated preferences as user_confirmed", () => {
		const [candidate] = extractDefaultMemoryCandidates({
			rawRequest: "I prefer terse status updates.",
			message: assistantMessage("ok"),
			scope: "global",
			subject: "user",
			now: 10,
		});

		expect(candidate).toMatchObject({
			predicate: "prefers",
			object: "terse status updates",
			trust: "user_confirmed",
		});
	});

	it("downgrades assistant-authored tool-evidenced facts without receipt linkage", () => {
		const candidates = extractDefaultMemoryCandidates({
			rawRequest: "Continue.",
			message: assistantMessage([
				"tool-evidenced: project.language=TypeScript",
				"model-inferred: user.prefers=review first",
			].join("\n")),
			scope: "repo",
			subject: "user",
			now: 20,
		});

		expect(candidates.map((candidate) => candidate.trust)).toEqual(["model_inferred", "model_inferred"]);
		expect(candidates.map((candidate) => candidate.subject)).toEqual(["project", "user"]);
	});

	it("accepts tool-evidenced facts only when linked to an actual receipt id", () => {
		const candidates = extractDefaultMemoryCandidates({
			rawRequest: "Continue.",
			message: assistantMessage("tool-evidenced[receipt-1]: project.language=TypeScript"),
			scope: "repo",
			subject: "user",
			now: 20,
			evidenceRefs: ["receipt-1"],
		});

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			subject: "project",
			predicate: "language",
			object: "TypeScript",
			trust: "tool_evidenced",
			source: "tool evidence:receipt-1",
		});
	});

	it("keeps model-inferred records out of lifecycle recall candidates", () => {
		const store = new InMemoryUserMemoryStore();
		const [inferred] = extractDefaultMemoryCandidates({
			rawRequest: "Continue.",
			message: assistantMessage("model-inferred: user.prefers=blue"),
			scope: "global",
			subject: "user",
			now: 30,
		});
		writeUserMemory(store, inferred);

		expect(recallUserMemories(store, { scope: "global", subject: "user", now: 30 })).toHaveLength(1);
		expect(recallUserMemories(store, { scope: "global", subject: "user", now: 30 })
			.filter((memory) => memory.trust !== "model_inferred")).toEqual([]);
	});
});
