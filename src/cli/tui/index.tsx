import React from "react";
import { render } from "ink";
import type { ReplHarness } from "../commands.ts";
import { App } from "./app.tsx";
import {
	createTuiPermissionController,
	type TuiPermissionController,
} from "./permission.tsx";

export { createTuiPermissionController };
export type { TuiPermissionController };

export interface RunTuiOptions {
	permissionController: TuiPermissionController;
}

export async function runTui(harness: ReplHarness, options: RunTuiOptions): Promise<void> {
	const instance = render(
		<App harness={harness} permissionController={options.permissionController} />,
		{ exitOnCtrlC: false },
	);
	await instance.waitUntilExit();
}
