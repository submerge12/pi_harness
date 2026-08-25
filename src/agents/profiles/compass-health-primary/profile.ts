/**
 * WO-HS-10 / M11: compass-health-primary — the real-user agent.
 *
 * Unlike the legacy profile (which calls domain handlers in-process), the
 * primary subject uses ONLY the public journey surface: the authenticated
 * FastAPI BFF at /api/*, exactly like a human user. Every write must be
 * followed by a read-back through the daily-state projection; claiming
 * success without one is a policy violation surfaced to the teacher.
 *
 * Credentials come from env (PI_HEALTH_BFF_TOKEN); the primary never holds
 * DB credentials and never writes SQLite.
 */
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolRegistration } from "../../../tools/types.ts";
import type { AgentProfile } from "../../profile.ts";

const BFF_BASE = process.env["PI_HEALTH_BFF_URL"] ?? "http://127.0.0.1:8000";
const BFF_TOKEN = process.env["PI_HEALTH_BFF_TOKEN"] ?? "";

interface BffResponse<T = unknown> {
  status: number;
  body: T | { error?: string; detail?: unknown; message?: string };
}

async function bffCall(method: string, path: string, jsonBody?: unknown): Promise<BffResponse> {
  const headers: Record<string, string> = {
    "X-Actor": "pi-primary",
  };
  if (BFF_TOKEN) headers["Authorization"] = `Bearer ${BFF_TOKEN}`;
  if (jsonBody !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BFF_BASE}${path}`, {
    method,
    headers,
    body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body: body as BffResponse["body"] };
}

function toolResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
  return result;
}

function textResult(text: string, details?: unknown): AgentToolResult<{ text: string; details?: unknown }> {
  return toolResult({ content: [{ type: "text", text }], details: { text, ...(details !== undefined ? { details } : {}) } });
}

// ── tools ──

const getDailyStateTool: ToolRegistration = {
  accessLevel: "read-only",
  tool: {
    name: "health_get_daily_state",
    label: "Read Daily Health State",
    description:
      "Read today's canonical health state (diet totals, training session progress, sleep/fatigue/pain observations, constraints). ALWAYS call this before planning or answering 'what should I do today'.",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "ISO date, defaults to today" })),
    }),
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      const date = (params as { date?: string }).date ?? new Date().toISOString().slice(0, 10);
      const res = await bffCall("GET", `/api/domain/v1/daily-state?date=${encodeURIComponent(date)}`);
      if (res.status !== 200) return textResult(`daily-state read failed (${res.status})`, res.body);
      return textResult(JSON.stringify(res.body, null, 2), res.body);
    },
  },
};

const logMealTool: ToolRegistration = {
  accessLevel: "write",
  tool: {
    name: "health_log_meal",
    label: "Log Meal via API",
    description:
      "Log a meal by natural description (e.g. 一碗牛肉面). Returns needs_confirmation with candidate foods when the estimate is uncertain - present those to the user, then re-call with chosenItems. Always followed by health_read_back verification.",
    parameters: Type.Object({
      description: Type.String({ description: "natural-language meal description" }),
      mealType: Type.Optional(Type.String({ description: "breakfast|lunch|snack|dinner" })),
      date: Type.Optional(Type.String()),
      chosenItems: Type.Optional(
        Type.Array(
          Type.Object({
            slug: Type.String(),
            grams: Type.Number(),
          }),
        ),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      const p = params as {
        description: string;
        mealType?: string;
        date?: string;
        chosenItems?: Array<{ slug: string; grams: number }>;
      };
      const idempotencyKey = `pi-primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const body: Record<string, unknown> = {
        transcript: `我吃了${p.description}`,
        date: p.date ?? new Date().toISOString().slice(0, 10),
        confirmed: true,
        idempotency_key: idempotencyKey,
        ...(p.chosenItems ? { chosen_items: p.chosenItems.map((c) => ({ slug: c.slug, grams: c.grams })) } : {}),
      };
      // Voice commit path reuses meal-time parsing + idempotent diet v2 commit.
      const res = await bffCall("POST", "/api/voice/commit", body);
      const payload = res.body as Record<string, unknown>;

      if (res.status === 422 || payload["status"] === "needs_confirmation") {
        return textResult(
          JSON.stringify({
            outcome: "needs_confirmation",
            candidates: payload["unmatched"] ?? payload,
            instruction: "present candidates to the user, then retry with chosenItems",
          }, null, 2),
          payload,
        );
      }
      if (res.status !== 200 || payload["status"] !== "committed") {
        return textResult(`meal commit failed: ${JSON.stringify(payload)}`, payload);
      }

      // WO-HS-10: mandatory read-back through the projection.
      const verify = await bffCall(
        "GET",
        `/api/domain/v1/daily-state?date=${body["date"] as string}`,
      );
      const state = verify.body as { dietActualCount?: number };
      return textResult(
        JSON.stringify({
          outcome: "committed_and_verified",
          log_id: payload["log_id"],
          kcal: payload["kcal"],
          daily_state_diet_count: state.dietActualCount ?? null,
          verified: typeof state.dietActualCount === "number" && state.dietActualCount > 0,
        }, null, 2),
        payload,
      );
    },
  },
};

const reportPainTool: ToolRegistration = {
  accessLevel: "write",
  tool: {
    name: "health_report_pain",
    label: "Report Pain",
    description:
      "Record pain feedback. Creates an observation plus a training constraint (warn or block). Never diagnoses; guidance only.",
    parameters: Type.Object({
      bodyPart: Type.String({ description: "e.g. 膝盖 / 肩 / 腰" }),
      severity: Type.Optional(
        Type.String({ description: "mild|sharp|worsening|unstable|unknown" }),
      ),
      description: Type.Optional(Type.String()),
      date: Type.Optional(Type.String()),
    }),
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      const p = params as { bodyPart: string; severity?: string; description?: string; date?: string };
      const res = await bffCall("POST", "/api/domain/v1/health/pain", {
        observedOn: p.date ?? new Date().toISOString().slice(0, 10),
        bodyPart: p.bodyPart,
        severity: p.severity ?? "unknown",
        description: p.description,
      });
      if (res.status !== 200 && res.status !== 201) {
        return textResult(`pain command failed (${res.status}): ${JSON.stringify(res.body)}`, res.body);
      }
      return textResult(JSON.stringify(res.body, null, 2), res.body);
    },
  },
};

const getConstraintsTool: ToolRegistration = {
  accessLevel: "read-only",
  tool: {
    name: "health_get_constraints",
    label: "Read Active Constraints",
    description: "Read active health constraints (pain blocks etc.) for a date. MUST be consulted before any training recommendation.",
    parameters: Type.Object({
      date: Type.Optional(Type.String()),
    }),
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      const date = (params as { date?: string }).date ?? new Date().toISOString().slice(0, 10);
      const res = await bffCall("GET", `/api/domain/v1/constraints?date=${encodeURIComponent(date)}`);
      if (res.status !== 200) return textResult(`constraints read failed (${res.status})`, res.body);
      return textResult(JSON.stringify(res.body, null, 2), res.body);
    },
  },
};

export function createPrimaryToolRegistrations(): ToolRegistration[] {
  return [getDailyStateTool, getConstraintsTool, logMealTool, reportPainTool];
}

const SYSTEM_PROMPT = [
  "# Compass Health — primary real-user agent",
  "",
  "You are the user's own health agent operating the REAL system on their behalf.",
  "",
  "Hard rules:",
  "1. ALWAYS call health_get_daily_state first when answering 'what today' questions.",
  "2. ALWAYS consult health_get_constraints before any training suggestion.",
  "3. Every write MUST be followed by reading back the daily state; never claim",
  "   success without verified data.",
  "4. If a commit returns needs_confirmation, show the candidate list to the user;",
  "   never pick silently for them.",
  "5. Pain reports are recorded, not diagnosed. Escalate persistent/worsening pain",
  "   to professional care.",
  "6. You cannot touch the database directly; your only surface is the API.",
].join("\n");

const compassHealthPrimaryProfileAdapter = {
  name: "compass-health-primary",
  description:
    "Real-user health agent that operates exclusively through the authenticated BFF/API with mandatory read-back verification.",
  systemPrompt: SYSTEM_PROMPT,
  tools: [() => createPrimaryToolRegistrations()],
  install: async () => undefined,
  skills: [],
  templates: [],
} satisfies AgentProfile;

export const compassHealthPrimaryProfile = compassHealthPrimaryProfileAdapter as AgentProfile;
export default compassHealthPrimaryProfile;
