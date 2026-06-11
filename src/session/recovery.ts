import { readFile, writeFile } from "node:fs/promises";

export interface JsonlTailRecoveryResult {
	droppedBytes: number;
	droppedLines: number;
	filePath: string;
	lineCount: number;
	repaired: boolean;
}

export class JsonlTailRecoveryError extends Error {
	filePath: string;
	lineNumber: number;

	constructor(filePath: string, lineNumber: number, cause: unknown) {
		super(`Invalid JSONL in ${filePath} at line ${lineNumber}`);
		this.name = "JsonlTailRecoveryError";
		this.filePath = filePath;
		this.lineNumber = lineNumber;
		this.cause = cause;
	}
}

interface JsonlLines {
	hasTrailingLineBreak: boolean;
	lines: string[];
}

function splitJsonl(content: string): JsonlLines {
	const hasTrailingLineBreak = content.endsWith("\n") || content.endsWith("\r");
	const lines = content.split(/\r?\n/);
	if (hasTrailingLineBreak) lines.pop();
	return { hasTrailingLineBreak, lines };
}

function prefixBeforeTrailingLine(content: string): string {
	const lastNewlineIndex = content.lastIndexOf("\n");
	return lastNewlineIndex === -1 ? "" : content.slice(0, lastNewlineIndex + 1);
}

function validateJsonLine(line: string, filePath: string, lineNumber: number): void {
	if (!line.trim()) return;
	try {
		JSON.parse(line);
	} catch (error) {
		throw new JsonlTailRecoveryError(filePath, lineNumber, error);
	}
}

export async function repairJsonlTail(filePath: string): Promise<JsonlTailRecoveryResult> {
	const content = await readFile(filePath, "utf8");
	if (!content) {
		return { droppedBytes: 0, droppedLines: 0, filePath, lineCount: 0, repaired: false };
	}

	const { hasTrailingLineBreak, lines } = splitJsonl(content);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const lineNumber = index + 1;
		const isTrailingLine = index === lines.length - 1;
		try {
			validateJsonLine(line, filePath, lineNumber);
		} catch (error) {
			if (isTrailingLine && !hasTrailingLineBreak) {
				const repairedContent = prefixBeforeTrailingLine(content);
				await writeFile(filePath, repairedContent, "utf8");
				return {
					droppedBytes: Buffer.byteLength(content) - Buffer.byteLength(repairedContent),
					droppedLines: 1,
					filePath,
					lineCount: Math.max(0, lines.length - 1),
					repaired: true,
				};
			}
			throw error;
		}
	}

	return { droppedBytes: 0, droppedLines: 0, filePath, lineCount: lines.length, repaired: false };
}
