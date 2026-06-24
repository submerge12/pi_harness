import { Type } from "typebox";
import type { Static } from "typebox";
import { taskContractSchema } from "./task-contract.ts";

export const planDependencySchema = Type.Object(
	{
		taskId: Type.String(),
		dependsOn: Type.String(),
	},
	{ additionalProperties: false },
);

export const planPackageSchema = Type.Object(
	{
		tasks: Type.Array(taskContractSchema),
		dependencies: Type.Array(planDependencySchema),
	},
	{ additionalProperties: false },
);

export type PlanDependency = Static<typeof planDependencySchema>;
export type PlanPackage = Static<typeof planPackageSchema>;
