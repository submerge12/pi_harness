import type { Api, KnownProvider, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ResolvedHarnessConfig } from "./config.ts";

let defaultModels: Models | undefined;

function getDefaultModels(): Models {
	defaultModels ??= builtinModels();
	return defaultModels;
}

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

export function resolveModel(
	provider: KnownProvider,
	modelId: string,
	models: Pick<Models, "getModel"> = getDefaultModels(),
): Model<Api> {
	const model = models.getModel(provider, modelId) as Model<Api> | undefined;
	if (!model) throw new ModelResolutionError(provider, modelId);
	return model;
}

export function resolveHarnessModel(
	config: ResolvedHarnessConfig,
	models?: Pick<Models, "getModel">,
): Model<Api> {
	return resolveModel(config.provider, config.modelId, models);
}
