export interface TokenBudgetRatios {
	pinned: number;
	warm: number;
	cold: number;
}

export interface TokenBudget {
	contextWindow: number;
	pinned: number;
	warm: number;
	cold: number;
}

export const DEFAULT_TOKEN_BUDGET_RATIOS: TokenBudgetRatios = {
	pinned: 0,
	warm: 0.75,
	cold: 0.25,
};

const RATIO_SUM_EPSILON = 0.000001;

function assertRatio(name: keyof TokenBudgetRatios, value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`Token budget ratio ${name} must be between 0 and 1`);
	}
}

export function computeTokenBudget(
	contextWindow: number,
	ratios: TokenBudgetRatios = DEFAULT_TOKEN_BUDGET_RATIOS,
): TokenBudget {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		throw new Error("contextWindow must be a positive finite number");
	}

	assertRatio("pinned", ratios.pinned);
	assertRatio("warm", ratios.warm);
	assertRatio("cold", ratios.cold);

	const ratioSum = ratios.pinned + ratios.warm + ratios.cold;
	if (Math.abs(ratioSum - 1) > RATIO_SUM_EPSILON) {
		throw new Error("Token budget ratios must sum to 1");
	}

	const normalizedContextWindow = Math.floor(contextWindow);
	const pinned = Math.floor(normalizedContextWindow * ratios.pinned);
	const warm = Math.floor(normalizedContextWindow * ratios.warm);
	const cold = normalizedContextWindow - pinned - warm;

	return {
		contextWindow: normalizedContextWindow,
		pinned,
		warm,
		cold,
	};
}
