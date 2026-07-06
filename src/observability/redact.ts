import { redactText, redactUnknown, REDACTED_VALUE } from "../redaction/core.ts";

export function redactString(value: string): string {
	return redactText(value).text;
}

export function redact(value: unknown): unknown {
	return redactUnknown(value);
}

export { REDACTED_VALUE };
