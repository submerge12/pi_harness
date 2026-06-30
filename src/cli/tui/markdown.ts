import { Marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

const markdownRenderer = new Marked();
markdownRenderer.use(
	markedTerminal({
		reflowText: false,
		tab: 2,
	}) as unknown as MarkedExtension,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeMarkdownTokens(tokens: unknown): void {
	if (!Array.isArray(tokens)) return;
	for (const token of tokens) {
		if (!isRecord(token)) continue;

		if (token.type === "list_item" && Array.isArray(token.tokens)) {
			token.tokens = token.tokens.map((child) => {
				if (!isRecord(child) || child.type !== "text" || !Array.isArray(child.tokens)) return child;
				return { ...child, type: "paragraph" };
			});
		}

		normalizeMarkdownTokens(token.tokens);
		if (Array.isArray(token.items)) {
			for (const item of token.items) {
				if (isRecord(item)) normalizeMarkdownTokens([item]);
			}
		}
	}
}

export function finalizeMarkdown(text: string): string {
	const tokens = markdownRenderer.lexer(text);
	normalizeMarkdownTokens(tokens);
	const rendered = markdownRenderer.parser(tokens);
	return typeof rendered === "string" ? rendered.trimEnd() : text.trimEnd();
}
