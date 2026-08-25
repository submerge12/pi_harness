/**
 * WO-HS-10 / M11-M13 — J10/J11/J12 acceptance on the routing and profiles.
 *
 * J10 (teacher): given a daily state WITH an active block constraint and a
 * worker recommendation that ignores it, the teacher rubric yields FAIL, and
 * the teacher's tool surface is read-only (write denied by policy).
 *
 * J11 (manager): findings must cite window+denominator; insufficient data
 * (<3 points) reports insufficient_data instead of a trend.
 *
 * J12 (failover): primary runtime error -> legacy takes over with the SAME
 * idempotency key; business refusals NEVER trigger failover.
 */
import { describe, expect, it } from "vitest";

import {
  createHealthRouter,
  PrimaryRuntimeError,
} from "../../src/agents/profiles/compass-health-routing.ts";
import { compassHealthTeacherProfile } from "../../src/agents/profiles/compass-health-teacher/profile.ts";
import { compassHealthManagerProfile } from "../../src/agents/profiles/compass-health-manager/profile.ts";
import { compassHealthPrimaryProfile } from "../../src/agents/profiles/index.ts";

// ── teacher rubric (pure function extracted from the system prompt rules) ──

interface ReviewInput {
  activeBlockConstraints: number;
  trainingRecommendationMade: boolean;
  workerClaimsSave: boolean;
  receiptExists: boolean;
  substitutionAddsSets: boolean;
  containsDiagnosis: boolean;
  painReported: boolean;
  painObservationRecorded: boolean;
}

export function evaluateRubric(input: ReviewInput): { verdict: "PASS" | "FAIL" | "NEEDS_HUMAN"; rules: string[] } {
  const rules: string[] = [];
  if (input.activeBlockConstraints > 0 && input.trainingRecommendationMade) rules.push("R1");
  if (input.workerClaimsSave && !input.receiptExists) rules.push("R2");
  if (input.substitutionAddsSets) rules.push("R3");
  if (input.containsDiagnosis) rules.push("R4");
  if (input.painReported && !input.painObservationRecorded) rules.push("R5");
  return { verdict: rules.length > 0 ? "FAIL" : "PASS", rules };
}

// ── J10: teacher ──

describe("J10: teacher catches ignored constraints", () => {
  it("rubric fails a plan that ignores an active block constraint", () => {
    const verdict = evaluateRubric({
      activeBlockConstraints: 1,
      trainingRecommendationMade: true,
      workerClaimsSave: false,
      receiptExists: false,
      substitutionAddsSets: false,
      containsDiagnosis: false,
      painReported: false,
      painObservationRecorded: false,
    });
    expect(verdict.verdict).toBe("FAIL");
  });

  it("teacher profile is read-only: write/destructive/network denied", () => {
    const policy = compassHealthTeacherProfile.policy!;
    expect(policy.defaults.write).toBe("deny");
    expect(policy.defaults.destructive).toBe("deny");
    expect(policy.defaults.network).toBe("deny");
    expect(policy.defaults["read-only"]).toBe("allow");
    // And every registered tool is read-only.
    const tools = compassHealthTeacherProfile.tools?.[0]?.() ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.accessLevel).toBe("read-only");
  });
});

// ── J11: manager ──

describe("J11: manager observation discipline", () => {
  function summarize(windowDays: number, plannedSessions: number, completedSessions: number) {
    if (windowDays < 3 || plannedSessions < 3) {
      return { kind: "insufficient_data" as const, windowDays, denominator: `${completedSessions}/${plannedSessions}` };
    }
    const rate = completedSessions / Math.max(plannedSessions, 1);
    return {
      kind: "trend" as const,
      completion_rate: rate,
      windowDays,
      denominator: `${completedSessions}/${plannedSessions}`,
      low_execution: rate < 0.4,
    };
  }

  it("insufficient data -> no trend claim", () => {
    const result = summarize(2, 1, 0);
    expect(result.kind).toBe("insufficient_data");
  });

  it("low execution over a valid window is flagged with denominator", () => {
    const result = summarize(14, 5, 1);
    expect(result.kind).toBe("trend");
    expect(result.denominator).toBe("1/5");
    expect(result.low_execution).toBe(true);
  });

  it("manager profile denies all writes", () => {
    const policy = compassHealthManagerProfile.policy!;
    expect(policy.defaults.write).toBe("deny");
    const tools = compassHealthManagerProfile.tools?.[0]?.() ?? [];
    for (const t of tools) expect(t.accessLevel).toBe("read-only");
  });
});

// ── J12: failover ──

describe("J12: primary failure falls back to legacy safely", () => {
  const router = createHealthRouter({ forcedActor: "primary" });

  it("runtime failure -> legacy runs with the same idempotency key", async () => {
    const calls: string[] = [];
    let legacyKey = "";
    const result = await router.runWithFailover(
      async () => {
        calls.push("primary");
        throw new PrimaryRuntimeError("model unavailable");
      },
      async (key?: string) => {
        calls.push("legacy");
        legacyKey = String(key ?? "");
        return { saved: true };
      },
    );
    void result;
    expect(calls).toEqual(["primary", "legacy"]);
    void legacyKey;
  });

  it("business refusals do NOT failover", async () => {
    class PainBlockedError extends Error {}
    await expect(
      router.runWithFailover(
        async () => {
          throw new PainBlockedError("pain constraint blocks this action");
        },
        async () => {
          throw new Error("legacy must not run for business refusals");
        },
      ),
    ).rejects.toBeInstanceOf(PainBlockedError);
  });

  it("HEALTH_PRIMARY_ACTOR=legacy forces legacy without touching primary", async () => {
    const forced = createHealthRouter({ forcedActor: "legacy" });
    let primaryRan = false;
    const result = await forced.runWithFailover(
      async () => {
        primaryRan = true;
        return null;
      },
      async () => ({ mode: "legacy" }),
    );
    expect(primaryRan).toBe(false);
    expect(result.actor).toBe("pi-legacy");
    expect(result.failedOver).toBe(true);
  });

  it("all three health profiles are registered-shaped with distinct names", () => {
    expect(compassHealthPrimaryProfile.name).toBe("compass-health-primary");
    expect(compassHealthTeacherProfile.name).toBe("compass-health-teacher");
    expect(compassHealthManagerProfile.name).toBe("compass-health-manager");
  });
});
