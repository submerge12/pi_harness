import type {
	Credential,
	CredentialInfo,
	CredentialStore,
	Models,
} from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ResolvedHarnessConfig } from "./config.ts";

class HarnessCredentialStore implements CredentialStore {
	private readonly delegate = new InMemoryCredentialStore();
	private readonly seeds = new Map<string, Credential>();

	constructor(provider: string, apiKey: string) {
		this.seeds.set(provider, { type: "api_key", key: apiKey });
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return cloneCredential(await this.delegate.read(providerId) ?? this.seeds.get(providerId));
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map<string, CredentialInfo>();
		for (const [providerId, credential] of this.seeds) {
			entries.set(providerId, { providerId, type: credential.type });
		}
		for (const info of await this.delegate.list()) entries.set(info.providerId, info);
		return [...entries.values()];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const result = await this.delegate.modify(providerId, async (current) => {
			const effective = current ?? this.seeds.get(providerId);
			const next = await fn(cloneCredential(effective));
			if (next === undefined) return cloneCredential(effective);
			this.seeds.delete(providerId);
			return cloneCredential(next);
		});
		return cloneCredential(result);
	}

	async delete(providerId: string): Promise<void> {
		this.seeds.delete(providerId);
		await this.delegate.delete(providerId);
	}
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
	return credential === undefined ? undefined : structuredClone(credential);
}

export function createHarnessModels(
	config: Pick<ResolvedHarnessConfig, "apiKey" | "provider">,
): Models {
	const credentials = config.apiKey
		? new HarnessCredentialStore(config.provider, config.apiKey)
		: undefined;
	return builtinModels(credentials ? { credentials } : undefined);
}
