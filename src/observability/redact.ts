const SECRET_KEY_PATTERN = /key|token|secret|password|authorization|cookie|credential|session/i;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s"'`,;)}\]]+/gi;

export const REDACTED_VALUE = "[REDACTED]";
const CIRCULAR_VALUE = "[Circular]";

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function isSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key);
}

export function redactString(value: string): string {
	return value.replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]");
}

function redactObject(value: object, seen: WeakSet<object>): unknown {
	if (seen.has(value)) return CIRCULAR_VALUE;
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((entry) => redactValue(entry, seen));
	}

	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		output[key] = isSecretKey(key) ? REDACTED_VALUE : redactValue(entry, seen);
	}
	return output;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactString(value);
	if (!isObject(value)) return value;
	return redactObject(value, seen);
}

export function redact(value: unknown): unknown {
	return redactValue(value, new WeakSet<object>());
}
