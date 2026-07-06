import { redactText } from "../redaction/core.ts";

export interface RedactedCommandOutput {
	text: string;
	redactions: number;
}

export function redactCommandOutput(text: string): RedactedCommandOutput {
	return redactText(text);
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
