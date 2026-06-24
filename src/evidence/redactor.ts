import { redactString, REDACTED_VALUE } from "../observability/redact.ts";

const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s"'`,;)}\]]+/gi;
const QUOTED_HEADER_SECRET_PATTERN =
	/(["'`])((?:authorization|cookie)\s*[:=]\s*)[^\r\n"'`]*\1/gi;
const UNQUOTED_INLINE_AUTHORIZATION_HEADER_PATTERN =
	/(\B(?:-H|--header)\s+authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s"'`,;)}\]]+/gi;
const UNQUOTED_INLINE_COOKIE_HEADER_PATTERN =
	/(\B(?:-H|--header)\s+cookie\s*[:=]\s*)[^\r\n]+?(?=\s+-{1,2}[A-Za-z]|\s+https?:\/\/|\s*$)/gi;
const HEADER_SECRET_LINE_PATTERN = /^(\s*(?:authorization|cookie)\s*[:=]\s*)[^\r\n]+/gim;
const ASSIGNMENT_PATTERN =
	/\b([A-Za-z_][A-Za-z0-9_.-]*)\s*([=:])\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;,&|)]+)/gi;
const JSON_SECRET_PROPERTY_PATTERN =
	/("[^"\r\n]*(?:key|token|secret|password|authorization|cookie|credential|session)[^"\r\n]*"\s*:\s*)("[^"\r\n]*")/gi;
const SECRET_ASSIGNMENT_KEY_PATTERN = /key|token|secret|password|authorization|cookie|credential|session/i;
const URL_SECRET_QUERY_PATTERN =
	/([?&][^=\s&#"'`<>)]*(?:key|token|secret|password|authorization|cookie|credential|session)[^=\s&#"'`<>)]*=)[^&\s"'`<>)]*/gi;

export interface RedactedCommandOutput {
	text: string;
	redactions: number;
}

function countMatches(pattern: RegExp, text: string): number {
	pattern.lastIndex = 0;
	let count = 0;
	while (pattern.exec(text) !== null) count += 1;
	pattern.lastIndex = 0;
	return count;
}

export function redactCommandOutput(text: string): RedactedCommandOutput {
	let headerRedactions = 0;
	let assignmentRedactions = 0;
	const headerRedacted = text
		.replace(QUOTED_HEADER_SECRET_PATTERN, (_match, quote: string, prefix: string) => {
			headerRedactions += 1;
			return `${quote}${prefix}${REDACTED_VALUE}${quote}`;
		})
		.replace(UNQUOTED_INLINE_AUTHORIZATION_HEADER_PATTERN, (_match, prefix: string) => {
			headerRedactions += 1;
			return `${prefix}${REDACTED_VALUE}`;
		})
		.replace(UNQUOTED_INLINE_COOKIE_HEADER_PATTERN, (_match, prefix: string) => {
			headerRedactions += 1;
			return `${prefix}${REDACTED_VALUE}`;
		})
		.replace(HEADER_SECRET_LINE_PATTERN, (_match, prefix: string) => {
			headerRedactions += 1;
			return `${prefix}${REDACTED_VALUE}`;
		});
	const bearerRedactions = countMatches(BEARER_TOKEN_PATTERN, headerRedacted);
	const bearerRedacted = redactString(headerRedacted);
	let queryRedactions = 0;
	const queryRedacted = bearerRedacted.replace(URL_SECRET_QUERY_PATTERN, (_match, prefix: string) => {
		queryRedactions += 1;
		return `${prefix}${REDACTED_VALUE}`;
	});
	const jsonPropertyRedactions = countMatches(JSON_SECRET_PROPERTY_PATTERN, queryRedacted);
	const jsonRedacted = queryRedacted.replace(JSON_SECRET_PROPERTY_PATTERN, `$1"${REDACTED_VALUE}"`);
	const redacted = jsonRedacted.replace(ASSIGNMENT_PATTERN, (match, key: string, separator: string, value: string) => {
		if (!SECRET_ASSIGNMENT_KEY_PATTERN.test(key)) return match;
		if (value === REDACTED_VALUE) return match;
		if (separator === ":" && /^authorization$/i.test(key) && /^authorization\s*:\s*Bearer$/i.test(match)) {
			return match;
		}
		assignmentRedactions += 1;
		return `${key}${separator}${REDACTED_VALUE}`;
	});

	return {
		text: redacted,
		redactions: headerRedactions + bearerRedactions + queryRedactions + jsonPropertyRedactions + assignmentRedactions,
	};
}

export function containsBinaryOutput(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
		if (code <= 0x1f) return true;
		if (code >= 0xfff9 && code <= 0xfffb) return true;
	}
	return false;
}
