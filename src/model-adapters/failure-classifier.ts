import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProviderErrorClassification } from "../resilience/errors.ts";
import type { ModelFailureSignatures, ModelProfile } from "../model-profiles/types.ts";

export type ModelFailureKind = "refusal" | "loop" | "truncation";

export interface ModelFailureClassification {
	kind: ModelFailureKind;
	/** Source pattern that matched, for diagnostics. */
	pattern: string;
}

const signatureOrder: readonly ModelFailureKind[] = ["refusal", "loop", "truncation"];
const maxSignatureChars = 64 * 1024;
const maxLoopWords = 2048;
const loopMinRepeats = 5;
const loopMinWindowWords = 4;
const loopMaxWindowWords = 32;

export class ModelFailureError extends Error {
	classification: ModelFailureClassification;
	outputText: string;
	assistantMessage?: AssistantMessage;

	constructor(
		classification: ModelFailureClassification,
		outputText: string,
		assistantMessage?: AssistantMessage,
	) {
		super(`Model output classified as ${classification.kind} by profile failure signatures.`);
		this.name = "ModelFailureError";
		this.classification = classification;
		this.outputText = outputText;
		if (assistantMessage) this.assistantMessage = assistantMessage;
	}
}

export function isModelFailureError(error: unknown): error is ModelFailureError {
	return error instanceof ModelFailureError;
}

export function classifyModelFailureError(error: unknown): ProviderErrorClassification | undefined {
	return isModelFailureError(error) ? failureRetryClassification(error.classification.kind) : undefined;
}

/**
 * Classifies assistant output text against a profile's declared failure signatures.
 * Returns the first matching kind in specificity order (refusal > loop > truncation).
 */
export function classifyModelFailure(
	text: string,
	profile: Pick<ModelProfile, "failureSignatures">,
): ModelFailureClassification | undefined {
	for (const kind of signatureOrder) {
		if (kind === "loop" && profile.failureSignatures.detectRepetitionLoops === true && detectRepetitionLoop(text)) {
			return { kind, pattern: "linear-repetition-loop-detector" };
		}
		const patterns = signaturePatterns(profile.failureSignatures, kind);
		const searchableText = kind === "truncation" ? tailText(text) : boundedSignatureText(text);
		for (const pattern of patterns) {
			pattern.lastIndex = 0;
			if (pattern.test(searchableText)) return { kind, pattern: pattern.source };
		}
	}
	return undefined;
}

/** Maps a classified model failure onto the retry policy: only truncation is worth retrying. */
export function failureRetryClassification(kind: ModelFailureKind): ProviderErrorClassification {
	return kind === "truncation" ? "transient" : "fatal";
}

function signaturePatterns(signatures: ModelFailureSignatures, kind: ModelFailureKind): readonly RegExp[] {
	if (kind === "refusal") return signatures.refusal ?? [];
	if (kind === "loop") return signatures.loop ?? [];
	return signatures.truncation ?? [];
}

function boundedSignatureText(text: string): string {
	if (text.length <= maxSignatureChars) return text;
	const headLength = Math.floor(maxSignatureChars / 2);
	const tailLength = maxSignatureChars - headLength;
	return `${text.slice(0, headLength)}\n${text.slice(-tailLength)}`;
}

function tailText(text: string): string {
	return text.length <= maxSignatureChars ? text : text.slice(-maxSignatureChars);
}

function detectRepetitionLoop(text: string): boolean {
	const words = tailText(text)
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean)
		.slice(-maxLoopWords);
	if (words.length < loopMinWindowWords * loopMinRepeats) return false;

	for (let windowSize = loopMinWindowWords; windowSize <= loopMaxWindowWords; windowSize += 1) {
		for (let start = 0; start + windowSize * loopMinRepeats <= words.length; start += 1) {
			if (hasRepeatedWindow(words, start, windowSize, loopMinRepeats)) return true;
		}
	}
	return false;
}

function hasRepeatedWindow(
	words: readonly string[],
	start: number,
	windowSize: number,
	minRepeats: number,
): boolean {
	for (let repeat = 1; repeat < minRepeats; repeat += 1) {
		const offset = start + repeat * windowSize;
		for (let index = 0; index < windowSize; index += 1) {
			if (words[start + index] !== words[offset + index]) return false;
		}
	}
	return true;
}
