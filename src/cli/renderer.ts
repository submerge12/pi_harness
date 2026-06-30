import type { HarnessEvent } from "../observability/types.ts";
import type { TextOutput } from "./cost-display.ts";
import { createCliRenderState, reduceCliEvent, type CliRenderState } from "./render-state.ts";

export interface CliRendererOptions {
	output: TextOutput;
	showThinking?: boolean;
}

export class CliRenderer {
	private output: TextOutput;
	private state: CliRenderState;
	private showThinking: boolean;

	constructor(options: CliRendererOptions) {
		this.output = options.output;
		this.state = createCliRenderState();
		this.showThinking = options.showThinking ?? false;
	}

	handleEvent(event: HarnessEvent): void {
		const result = reduceCliEvent(this.state, event, { showThinking: this.showThinking });
		this.state = result.state;
		for (const chunk of result.classicChunks) this.output.write(chunk);
	}
}
