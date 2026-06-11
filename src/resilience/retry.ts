import {
	classifyProviderError,
	getRetryAfterMs,
	type ProviderErrorClassification,
} from "./errors.ts";

export interface RetryEvent {
	attempt: number;
	attempts: number;
	classification: ProviderErrorClassification;
	delayMs: number;
	error: unknown;
	nextAttempt: number;
	retryAfterMs?: number;
}

export interface RetryOptions {
	attempts?: number;
	baseDelayMs?: number;
	classifyError?: (error: unknown) => ProviderErrorClassification;
	delay?: (delayMs: number, signal?: AbortSignal) => Promise<void> | void;
	maxDelayMs?: number;
	onRetry?: (event: RetryEvent) => Promise<void> | void;
	random?: () => number;
	signal?: AbortSignal;
}

export type RetryOperation<T> = (attempt: number, signal?: AbortSignal) => Promise<T> | T;

const defaultAttempts = 4;
const defaultBaseDelayMs = 1000;
const defaultMaxDelayMs = 30_000;

function createAbortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw createAbortError();
}

async function defaultDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return;
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", handleAbort);
			resolve();
		}, delayMs);

		function handleAbort(): void {
			clearTimeout(timeout);
			reject(createAbortError());
		}

		signal?.addEventListener("abort", handleAbort, { once: true });
	});
}

function normalizeAttempts(attempts: number | undefined): number {
	if (attempts === undefined) return defaultAttempts;
	if (!Number.isFinite(attempts)) return defaultAttempts;
	return Math.max(1, Math.floor(attempts));
}

function normalizeDelayMs(delayMs: number | undefined, fallback: number): number {
	if (delayMs === undefined || !Number.isFinite(delayMs)) return fallback;
	return Math.max(0, delayMs);
}

function normalizeRandom(random: () => number): number {
	const value = random();
	if (!Number.isFinite(value)) return 0;
	return Math.min(0.999_999, Math.max(0, value));
}

function calculateFullJitterDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	random: () => number,
): number {
	const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
	return Math.floor(cap * normalizeRandom(random));
}

export async function withRetry<T>(operation: RetryOperation<T>, options: RetryOptions = {}): Promise<T> {
	const attempts = normalizeAttempts(options.attempts);
	const baseDelayMs = normalizeDelayMs(options.baseDelayMs, defaultBaseDelayMs);
	const maxDelayMs = normalizeDelayMs(options.maxDelayMs, defaultMaxDelayMs);
	const classifyError = options.classifyError ?? classifyProviderError;
	const delay = options.delay ?? defaultDelay;
	const random = options.random ?? Math.random;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		throwIfAborted(options.signal);
		try {
			return await operation(attempt, options.signal);
		} catch (error) {
			throwIfAborted(options.signal);

			const classification = classifyError(error);
			if (classification === "fatal" || attempt >= attempts) throw error;

			const retryAfterMs = getRetryAfterMs(error);
			const delayMs =
				retryAfterMs ?? calculateFullJitterDelayMs(attempt, baseDelayMs, maxDelayMs, random);

			await options.onRetry?.({
				attempt,
				attempts,
				classification,
				delayMs,
				error,
				nextAttempt: attempt + 1,
				retryAfterMs,
			});
			await delay(delayMs, options.signal);
		}
	}

	throw new Error("Retry attempts exhausted");
}
