import { formatSessionCost, formatTurnCost } from "../observability/formatter.ts";
import type { CostSummary, TurnCost } from "../observability/types.ts";

export interface TextOutput {
	write(text: string): void;
}

export class CostDisplay {
	private output: TextOutput;

	constructor(output: TextOutput) {
		this.output = output;
	}

	renderTurn(turn: TurnCost): void {
		this.output.write(`${formatTurnCost(turn)}\n`);
	}

	renderSummary(summary: CostSummary): void {
		this.output.write(`${formatSessionCost(summary)}\n`);
	}
}
