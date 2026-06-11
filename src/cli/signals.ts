export type ReplSigintAction = "abort" | "exit";

export interface ReplSigintHarness {
	abort?: () => Promise<unknown> | unknown;
}

export interface ReplSigintController {
	handleSigint(): Promise<ReplSigintAction>;
	setTurnActive(active: boolean): void;
}

export interface ReplSigintControllerOptions {
	doublePressWindowMs?: number;
	harness: ReplSigintHarness;
	now?: () => number;
	onExit: () => Promise<void> | void;
}

export interface SigintTarget {
	off?(event: "SIGINT", listener: () => void): unknown;
	on(event: "SIGINT", listener: () => void): unknown;
	removeListener?(event: "SIGINT", listener: () => void): unknown;
}

const defaultDoublePressWindowMs = 2000;

export function createReplSigintController(options: ReplSigintControllerOptions): ReplSigintController {
	const now = options.now ?? Date.now;
	const doublePressWindowMs = options.doublePressWindowMs ?? defaultDoublePressWindowMs;
	let turnActive = false;
	let lastAbortAt: number | undefined;

	async function exit(): Promise<ReplSigintAction> {
		await options.onExit();
		return "exit";
	}

	return {
		async handleSigint(): Promise<ReplSigintAction> {
			const currentTime = now();
			const secondPressDuringTurn =
				lastAbortAt !== undefined && currentTime - lastAbortAt <= doublePressWindowMs;

			if (!turnActive || secondPressDuringTurn) return await exit();

			lastAbortAt = currentTime;
			await options.harness.abort?.();
			turnActive = false;
			return "abort";
		},
		setTurnActive(active: boolean): void {
			turnActive = active;
			if (active) lastAbortAt = undefined;
		},
	};
}

export function installReplSigintHandler(
	target: SigintTarget,
	controller: ReplSigintController,
): () => void {
	const listener = (): void => {
		void controller.handleSigint();
	};

	target.on("SIGINT", listener);

	return () => {
		if (target.off) {
			target.off("SIGINT", listener);
			return;
		}
		target.removeListener?.("SIGINT", listener);
	};
}
