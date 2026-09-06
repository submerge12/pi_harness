/**
 * WO-HS-10 / M11: health routing — primary first, legacy as explicit fallback.
 *
 * Failover to legacy happens ONLY for primary runtime failures (model
 * unavailable, profile install crash). Business refusals (validation,
 * pain-block, confirmation required) are NEVER failover triggers - they are
 * correct system behaviour. The caller receives the active actor in every
 * result so the UI can show fallback mode.
 */
export type HealthActor = "pi-primary" | "pi-legacy";

export interface HealthRoutingResult<T> {
  actor: HealthActor;
  result: T;
  failedOver: boolean;
  reason?: string;
}

export class PrimaryRuntimeError extends Error {
  constructor(reason: string) {
    super(`primary runtime failure: ${reason}`);
    this.name = "PrimaryRuntimeError";
  }
}

export interface HealthRoutingOptions {
  /** HEALTH_PRIMARY_ACTOR=legacy forces legacy without touching primary. */
  forcedActor?: "legacy" | "primary";
}

export function createHealthRouter(options: HealthRoutingOptions = {}) {
  const forced = options.forcedActor ?? (process.env["HEALTH_PRIMARY_ACTOR"] as "legacy" | "primary" | undefined) ?? "primary";

  return {
    /**
     * Run `primary`, falling back to `legacy` on PrimaryRuntimeError.
     * `run` implementations must propagate idempotency keys so a retried
     * action cannot duplicate facts across actors.
     */
    async runWithFailover<T>(
      primary: () => Promise<T>,
      legacy: () => Promise<T>,
    ): Promise<HealthRoutingResult<T>> {
      if (forced === "legacy") {
        return { actor: "pi-legacy", result: await legacy(), failedOver: true, reason: "forced_by_config" };
      }
      try {
        return { actor: "pi-primary", result: await primary(), failedOver: false };
      } catch (error) {
        if (!(error instanceof PrimaryRuntimeError)) throw error;
        return {
          actor: "pi-legacy",
          result: await legacy(),
          failedOver: true,
          reason: error.message,
        };
      }
    },
  };
}
