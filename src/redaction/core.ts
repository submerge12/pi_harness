export const REDACTED_VALUE = "[REDACTED]";
const CIRCULAR_VALUE = "[Circular]";
const MIN_KNOWN_SECRET_LENGTH = 4;

const SECRET_KEY_PATTERN = /key|token|secret|password|authorization|cookie|credential|session/i;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s"'`,;)}\]]+/gi;
const QUOTED_HEADER_SECRET_PATTERN =
	/(["'`])((?:authorization|cookie)\s*[:=]\s*)[^\r\n"'`]*\1/gi;
const UNQUOTED_INLINE_AUTHORIZATION_HEADER_PATTERN =
	/(\B(?:-H|--header)\s+authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"'`,;)}\]]+/gi;
const UNQUOTED_INLINE_COOKIE_HEADER_PATTERN =
	/(\B(?:-H|--header)\s+cookie\s*[:=]\s*)[^\r\n]+?(?=\s+-{1,2}[A-Za-z]|\s+https?:\/\/|\s*$)/gi;
const HEADER_SECRET_LINE_PATTERN = /^(\s*(?:authorization|cookie)\s*[:=]\s*)[^\r\n]+/gim;
const ASSIGNMENT_PATTERN =
	/\b([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;,&|)]+)/gi;
const JSON_SECRET_PROPERTY_PATTERN =
	/("[^"\r\n]*(?:key|token|secret|password|authorization|cookie|credential|session)[^"\r\n]*"\s*:\s*)("[^"\r\n]*")/gi;
const URL_SECRET_QUERY_PATTERN =
	/([?&][^=\s&#"'`<>)]*(?:key|token|secret|password|authorization|cookie|credential|session)[^=\s&#"'`<>)]*=)[^&\s"'`<>)]*/gi;

const knownSecrets = new Set<string>();

export interface RedactedText {
	text: string;
	redactions: number;
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function isSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAndCount(
	text: string,
	pattern: RegExp,
	replacement: string | ((match: string, ...captures: string[]) => string),
): RedactedText {
	let redactions = 0;
	pattern.lastIndex = 0;
	const output = text.replace(pattern, (match: string, ...captures: string[]) => {
		redactions += 1;
		if (typeof replacement === "string") return replacement;
		return replacement(match, ...captures);
	});
	pattern.lastIndex = 0;
	return { text: output, redactions };
}

function applyReplacement(
	current: RedactedText,
	pattern: RegExp,
	replacement: string | ((match: string, ...captures: string[]) => string),
): RedactedText {
	const result = replaceAndCount(current.text, pattern, replacement);
	return {
		text: result.text,
		redactions: current.redactions + result.redactions,
	};
}

function redactAssignments(current: RedactedText): RedactedText {
	let redactions = 0;
	ASSIGNMENT_PATTERN.lastIndex = 0;
	const text = current.text.replace(
		ASSIGNMENT_PATTERN,
		(match: string, key: string, separator: string, value: string) => {
			if (!isSecretKey(key)) return match;
			if (value.includes(REDACTED_VALUE)) return match;
			redactions += 1;
			return `${key}${separator}${REDACTED_VALUE}`;
		},
	);
	ASSIGNMENT_PATTERN.lastIndex = 0;
	return { text, redactions: current.redactions + redactions };
}

function redactKnownSecrets(current: RedactedText): RedactedText {
	let text = current.text;
	let redactions = 0;
	const secrets = [...knownSecrets].sort((first, second) => second.length - first.length);
	for (const secret of secrets) {
		if (!text.includes(secret)) continue;
		const pattern = new RegExp(escapeRegExp(secret), "g");
		text = text.replace(pattern, () => {
			redactions += 1;
			return REDACTED_VALUE;
		});
	}
	return { text, redactions: current.redactions + redactions };
}

export function registerKnownSecret(value: string | undefined | null): void {
	if (typeof value !== "string") return;
	const secret = value.trim();
	if (secret.length < MIN_KNOWN_SECRET_LENGTH || secret === REDACTED_VALUE) return;
	knownSecrets.add(secret);
}

export function clearKnownSecretsForTesting(): void {
	knownSecrets.clear();
}

export function redactText(value: string): RedactedText {
	let current: RedactedText = { text: value, redactions: 0 };
	current = applyReplacement(current, QUOTED_HEADER_SECRET_PATTERN, (_match, quote: string, prefix: string) =>
		`${quote}${prefix}${REDACTED_VALUE}${quote}`
	);
	current = applyReplacement(current, UNQUOTED_INLINE_AUTHORIZATION_HEADER_PATTERN, (_match, prefix: string) =>
		`${prefix}${REDACTED_VALUE}`
	);
	current = applyReplacement(current, UNQUOTED_INLINE_COOKIE_HEADER_PATTERN, (_match, prefix: string) =>
		`${prefix}${REDACTED_VALUE}`
	);
	current = applyReplacement(current, HEADER_SECRET_LINE_PATTERN, (_match, prefix: string) =>
		`${prefix}${REDACTED_VALUE}`
	);
	current = applyReplacement(current, BEARER_TOKEN_PATTERN, "Bearer [REDACTED]");
	current = applyReplacement(current, URL_SECRET_QUERY_PATTERN, (_match, prefix: string) =>
		`${prefix}${REDACTED_VALUE}`
	);
	current = applyReplacement(current, JSON_SECRET_PROPERTY_PATTERN, (_match, prefix: string) =>
		`${prefix}"${REDACTED_VALUE}"`
	);
	current = redactAssignments(current);
	current = redactKnownSecrets(current);
	return current;
}

function redactObject(value: object, seen: WeakSet<object>): unknown {
	if (seen.has(value)) return CIRCULAR_VALUE;
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((entry) => redactValue(entry, seen));
	}

	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		const redactedKey = uniqueObjectKey(output, redactText(key).text);
		output[redactedKey] = isSecretKey(key) ? REDACTED_VALUE : redactValue(entry, seen);
	}
	return output;
}

function uniqueObjectKey(output: Record<string, unknown>, key: string): string {
	if (!Object.hasOwn(output, key)) return key;
	let suffix = 2;
	while (Object.hasOwn(output, `${key}#${suffix}`)) suffix += 1;
	return `${key}#${suffix}`;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactText(value).text;
	if (typeof value === "function" || typeof value === "symbol") return undefined;
	if (typeof value === "bigint") return value.toString();
	if (!isObject(value)) return value;
	return redactObject(value, seen);
}

export function redactUnknown(value: unknown): unknown {
	return redactValue(value, new WeakSet<object>());
}
