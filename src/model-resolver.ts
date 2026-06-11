import { getModel } from "@earendil-works/pi-ai";
import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import type { ResolvedHarnessConfig } from "./config.ts";

export class ModelResolutionError extends Error {
	provider: KnownProvider;
	modelId: string;

	constructor(provider: KnownProvider, modelId: string) {
		super(`Unknown model ${provider}/${modelId}`);
		this.name = "ModelResolutionError";
		this.provider = provider;
		this.modelId = modelId;
	}
}

export function resolveModel(provider: KnownProvider, modelId: string): Model<Api> {
	const model = getModel(provider, modelId as never) as Model<Api> | undefined;
	if (!model) throw new ModelResolutionError(provider, modelId);
	return model;
}

export function resolveHarnessModel(config: ResolvedHarnessConfig): Model<Api> {
	return resolveModel(config.provider, config.modelId);
}
