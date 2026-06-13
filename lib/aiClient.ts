/* eslint-disable @typescript-eslint/no-explicit-any */

type MessageContentPart = {
  type: string;
  [key: string]: unknown;
};

interface Message {
  role: "system" | "user" | "assistant";
  content: string | MessageContentPart[];
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<\/think>\s*/gi, "")
    .trim();
}

function coerceToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return null;

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function safeEndpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.host}${url.pathname}`;
  } catch {
    return endpoint;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractTextFromOpenAIResponse(data: any): string | null {
  const directContent = data?.choices?.[0]?.message?.content;
  if (typeof directContent === "string") {
    const cleaned = stripThinkBlocks(directContent);
    return cleaned || null;
  }

  if (Array.isArray(directContent)) {
    const joined = directContent
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("");
    const cleaned = stripThinkBlocks(joined);
    return cleaned || null;
  }

  const fallback =
    data?.output_text ??
    data?.output?.[0]?.content?.find?.((part: any) => typeof part?.text === "string")?.text ??
    data?.output?.[0]?.content?.[0]?.text;

  const coerced = coerceToString(fallback);
  if (!coerced) return null;

  const cleaned = stripThinkBlocks(coerced);
  return cleaned || null;
}

export type LLMFailureReason =
  | "NOT_CONFIGURED"
  | "HTTP_ERROR"
  | "STATUS_HTTP_ERROR"
  | "JOB_FAILED"
  | "TIMEOUT"
  | "EMPTY_OUTPUT"
  | "EXCEPTION";

export type CallLLMResult =
  | {
      ok: true;
      content: string;
      jobId?: string;
    }
  | {
      ok: false;
      reason: LLMFailureReason;
      httpStatus?: number;
      jobId?: string;
      lastStatus?: string;
      message?: string;
    };

export type CallLLMOptions = {
  topP?: number;
  stop?: string[];
  guidedJson?: unknown;
  responseFormat?: unknown;
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  disableOpenAICompat?: boolean;
};

export async function callLLMResult(
  messages: Message[],
  maxTokens = 4000,
  temperature = 0.7,
  options?: CallLLMOptions
): Promise<CallLLMResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const timeoutMs =
    typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Math.min(300_000, Math.floor(options.timeoutMs)))
      : 120_000;

  if (!apiKey) {
    console.error("[aiClient] OPENAI_API_KEY missing");
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  const responseFormat =
    options?.responseFormat ??
    (options?.guidedJson
      ? {
          type: "json_schema",
          json_schema: {
            name: "output",
            strict: true,
            schema: options.guidedJson,
          },
        }
      : undefined);

  const body = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(typeof options?.topP === "number" ? { top_p: options.topP } : {}),
    ...(Array.isArray(options?.stop) && options.stop.length ? { stop: options.stop } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(options?.extraBody || {}),
  });

  try {
    console.log(`[aiClient] Calling OpenAI chat completions at ${safeEndpointLabel(endpoint)} (model=${model})`);

    const resp = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      },
      timeoutMs
    );

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      console.error(`[aiClient] OpenAI API error: ${resp.status} ${String(errorText || "").slice(0, 500)}`);
      return {
        ok: false,
        reason: "HTTP_ERROR",
        httpStatus: resp.status,
        message: String(errorText || "").slice(0, 500),
      };
    }

    const data = await resp.json();
    const content = extractTextFromOpenAIResponse(data);
    if (!content) {
      console.error("[aiClient] Empty response from OpenAI");
      return { ok: false, reason: "EMPTY_OUTPUT" };
    }

    console.log(`[aiClient] Generated ${content.length} characters`);
    return {
      ok: true,
      content,
      jobId: typeof data?.id === "string" ? data.id : undefined,
    };
  } catch (err: any) {
    if (String(err?.name || "") === "AbortError") {
      console.error("[aiClient] OpenAI request timed out (AbortError)");
      return { ok: false, reason: "TIMEOUT", message: "LLM request timed out" };
    }

    console.error("[aiClient] OpenAI request failed:", err?.message || err);
    return { ok: false, reason: "EXCEPTION", message: String(err?.message || err) };
  }
}

export async function callLLM(
  messages: Message[],
  maxTokens = 4000,
  temperature = 0.7
): Promise<string | null> {
  const result = await callLLMResult(messages, maxTokens, temperature);
  return result.ok ? result.content : null;
}
