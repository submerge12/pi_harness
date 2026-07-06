export interface ConfiguredToolMetadata {
	name: string;
	description?: unknown;
}

export interface ConfiguredToolSurfaces {
	tools?: readonly ConfiguredToolMetadata[];
	toolRegistrations?: readonly { tool: ConfiguredToolMetadata }[];
}

export function configuredTools(config: ConfiguredToolSurfaces): ConfiguredToolMetadata[] {
	const tools: ConfiguredToolMetadata[] = [];
	const seen = new Set<string>();
	const add = (tool: ConfiguredToolMetadata): void => {
		if (seen.has(tool.name)) return;
		seen.add(tool.name);
		tools.push(tool);
	};

	for (const registration of config.toolRegistrations ?? []) add(registration.tool);
	for (const tool of config.tools ?? []) add(tool);
	return tools;
}

export function configuredToolNames(config: ConfiguredToolSurfaces): string[] {
	return configuredTools(config).map((tool) => tool.name);
}
