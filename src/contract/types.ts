export type PlanLintErrorCode = "PLAN_E001" | "PLAN_E010" | "PLAN_E011" | "PLAN_E012" | "PLAN_E013" | "PLAN_E014";

export interface PlanLintError {
	code: PlanLintErrorCode;
	path: string;
	message: string;
}

export interface PlanLintResult {
	ok: boolean;
	errors: PlanLintError[];
}
