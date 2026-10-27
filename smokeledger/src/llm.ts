// Power layer: Meterless Nightshift Runtime (OpenAI-compatible), which routes to
// your Nemotron lanes. Uses fetch directly so the contract is visible:
// Bearer token + meterless-app + meterless-scope headers, /v1/models, /v1/chat/completions.

import { CONFIG } from "./config.ts";
import { countRemote, countSkipped, hostedInferenceAllowed, recordFailure } from "./tracing/context.ts";

export class HostedInferenceSkipped extends Error {}

/** True when this run may call Nightshift (not offline, token present). */
export const hostedAvailable = () => hostedInferenceAllowed(!!CONFIG.llm.token);

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

function headers(): Record<string, string> {
  if (!CONFIG.llm.token) throw new Error("METERLESS_RUNTIME_TOKEN is missing from .env (copy it from Nightshift > Console)");
  return {
    Authorization: `Bearer ${CONFIG.llm.token}`,
    "Content-Type": "application/json",
    "meterless-app": CONFIG.llm.app,
    "meterless-scope": "user",
  };
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${CONFIG.llm.baseUrl}/models`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new Error("Nightshift says unauthorized: check METERLESS_RUNTIME_TOKEN");
  if (!res.ok) throw new Error(`Nightshift /models HTTP ${res.status}`);
  const body = await res.json();
  return (body.data ?? []).map((m: { id: string }) => m.id);
}

export async function chat(
  messages: ChatMessage[],
  opts: { model?: string; tools?: ToolSpec[]; temperature?: number; json?: boolean } = {},
): Promise<{ message: ChatMessage; model: string }> {
  if (!hostedAvailable()) {
    countSkipped("nightshift.chat");
    throw new HostedInferenceSkipped("Hosted inference skipped (offline sample mode or no Nightshift token)");
  }
  const body: Record<string, unknown> = {
    model: opts.model ?? CONFIG.llm.modelDeep,
    messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.json) body.response_format = { type: "json_object" };
  const res = await fetch(`${CONFIG.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CONFIG.limits.modelSeconds * 1000),
  }).catch((e) => {
    recordFailure("nightshift", (e as Error).message);
    throw e;
  });
  const text = await res.text();
  if (!res.ok) {
    recordFailure("nightshift", `HTTP ${res.status}`);
    throw new Error(`Nightshift HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const j = JSON.parse(text);
  countRemote("nightshift.chat", j.id);
  return { message: j.choices[0].message, model: j.model ?? String(body.model) };
}

export async function llmAvailable(): Promise<boolean> {
  try {
    await listModels();
    return true;
  } catch {
    return false;
  }
}
