export type ProviderErrorClassification = "fatal" | "transient";

const transientNetworkCodes = new Set([
	"EAI_AGAIN",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETDOWN",
	"ENETRESET",
	"ENETUNREACH",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);

interface HeaderGetter {
	get(name: string): string | null | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const property = value[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const property = value[key];
	return typeof property === "string" ? property : undefined;
}

function getCause(value: unknown): unknown {
	return isRecord(value) ? value.cause : undefined;
}

function hasHeaderGetter(value: unknown): value is HeaderGetter {
	if (!isRecord(value)) return false;
	return typeof value.get === "function";
}

function getProviderStatus(error: unknown, depth = 0): number | undefined {
	if (depth > 4) return undefined;

	const directStatus = getNumberProperty(error, "status") ?? getNumberProperty(error, "statusCode");
	if (directStatus !== undefined) return directStatus;

	if (isRecord(error)) {
		const responseStatus = getProviderStatus(error.response, depth + 1);
		if (responseStatus !== undefined) return responseStatus;
	}

	return getProviderStatus(getCause(error), depth + 1);
}

function getHeaderFromObject(headers: Record<string, unknown>, name: string): string | undefined {
	const exact = headers[name];
	if (typeof exact === "string") return exact;

	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName && typeof value === "string") return value;
	}
	return undefined;
}

function getHeaderValue(source: unknown, name: string, depth = 0): string | undefined {
	if (depth > 4 || !isRecord(source)) return undefined;

	const headers = source.headers;
	if (hasHeaderGetter(headers)) {
		const value = headers.get(name);
		if (typeof value === "string") return value;
	}
	if (isRecord(headers)) {
		const value = getHeaderFromObject(headers, name);
		if (value !== undefined) return value;
	}

	const responseValue = getHeaderValue(source.response, name, depth + 1);
	if (responseValue !== undefined) return responseValue;

	return getHeaderValue(source.cause, name, depth + 1);
}

function parseRetryAfter(value: string, nowMs: number): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

	const dateMs = Date.parse(trimmed);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);

	return undefined;
}

function hasNetworkCode(error: unknown, depth = 0): boolean {
	if (depth > 4 || !isRecord(error)) return false;

	const code = getStringProperty(error, "code");
	if (code && transientNetworkCodes.has(code)) return true;

	const name = getStringProperty(error, "name");
	const message = getStringProperty(error, "message")?.toLowerCase();
	if (name === "TypeError" && message?.includes("fetch failed")) return true;
	if (message?.includes("network")) return true;

	return hasNetworkCode(error.cause, depth + 1);
}

export function classifyProviderError(error: unknown): ProviderErrorClassification {
	const status = getProviderStatus(error);
	if (status !== undefined) {
		if (status === 400 || status === 401 || status === 403) return "fatal";
		if (status === 408 || status === 429 || (status >= 500 && status < 600)) return "transient";
	}
	if (hasNetworkCode(error)) return "transient";
	return "fatal";
}

export function getRetryAfterMs(error: unknown, nowMs = Date.now()): number | undefined {
	const directMs = getNumberProperty(error, "retryAfterMs");
	if (directMs !== undefined) return Math.max(0, directMs);

	const directRetryAfter = getStringProperty(error, "retryAfter");
	if (directRetryAfter !== undefined) return parseRetryAfter(directRetryAfter, nowMs);

	const header = getHeaderValue(error, "retry-after");
	return header === undefined ? undefined : parseRetryAfter(header, nowMs);
}

export function getProviderApiKeyEnvVarName(provider: string): string {
	const normalized = provider.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return `${normalized.toUpperCase() || "PROVIDER"}_API_KEY`;
}

export function formatApiKeyErrorMessage(provider: string, envVarName?: string): string {
	const resolvedEnvVarName = envVarName ?? getProviderApiKeyEnvVarName(provider);
	return `Provider ${provider} rejected the request. Check ${resolvedEnvVarName} or pass --api-key.`;
}
