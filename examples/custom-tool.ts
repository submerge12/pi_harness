interface ToolResult {
	content: string;
}

interface LocalTool<Input extends Record<string, unknown>> {
	name: string;
	description: string;
	access: "read" | "write" | "network" | "destructive";
	run(input: Input): Promise<ToolResult>;
}

interface WordCountInput extends Record<string, unknown> {
	text: string;
}

function isWordCountInput(input: Record<string, unknown>): input is WordCountInput {
	return typeof input.text === "string";
}

const wordCountTool: LocalTool<WordCountInput> = {
	name: "word_count",
	description: "Count words in a text value.",
	access: "read",
	async run(input: WordCountInput): Promise<ToolResult> {
		const count = input.text.trim().split(/\s+/).filter(Boolean).length;
		return { content: JSON.stringify({ words: count }) };
	},
};

async function runTool(input: Record<string, unknown>): Promise<ToolResult> {
	if (!isWordCountInput(input)) {
		throw new TypeError("word_count requires a text string");
	}
	return wordCountTool.run(input);
}

const result = await runTool({ text: process.argv.slice(2).join(" ") || "custom tools stay small" });
console.log(`${wordCountTool.name}: ${result.content}`);
