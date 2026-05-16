/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AI Client for text generation using RunPod serverless endpoint with DeepSeek vLLM
 * This replaces OpenAI for text generation while keeping Whisper for audio transcription
 */

import { createHash } from "crypto";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

function stripThinkBlocks(text: string): string {
  // DeepSeek-style reasoning blocks can break JSON parsing downstream.
  // Remove <think>...</think> and also any stray closing tags.
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<\/think>\s*/gi, "")
    .trim();
}

function extractTextFromRunpodOutput(output: any): string | null {
  const root = Array.isArray(output) ? output?.[0] : output;

  const tokens: unknown = root?.choices?.[0]?.tokens;
  if (Array.isArray(tokens)) {
    const raw = tokens.map((t) => (typeof t === "string" ? t : "")).join("");
    const cleaned = stripThinkBlocks(raw);
    return cleaned || null;
  }

  const maybeText =
    root?.choices?.[0]?.message?.content ??
    root?.choices?.[0]?.text ??
    root?.output_text ??
    root?.generated_text ??
    root;


  if (typeof maybeText === "string") {

    const cleaned = stripThinkBlocks(maybeText);
    return cleaned || null;
  }


  const coerced = coerceToString(maybeText);
  if (!coerced) return null;
  const cleaned = stripThinkBlocks(coerced);
  return cleaned || null;
}


function safeEndpointLabel(endpoint: string): string {
  try {

    const url = new URL(endpoint);
    return `${url.host}${url.pathname}`;
  } catch {
    return endpoint;
  }
}


function parseEndpoint(endpoint: string): {
  url: URL | null;
  normalizedPathname: string | null;
} {
  try {
    const url = new URL(endpoint);

    const normalizedPathname = url.pathname.replace(/\/+$/, "");
    return { url, normalizedPathname };
  } catch {
    return { url: null, normalizedPathname: null };
  }
}

function buildRunpodStatusUrl(endpoint: string, jobId: string): string {

  const { url, normalizedPathname } = parseEndpoint(endpoint);
  if (!url || !normalizedPathname) {

    // Best-effort fallback matching prior behavior.
    return endpoint.replace(/\/run\/?($|\?)/, `/status/${jobId}$1`);
  }


  if (!normalizedPathname.endsWith("/run")) {
    return endpoint;
  }

  url.pathname = normalizedPathname.replace(/\/run$/, `/status/${jobId}`);
  // Status endpoints typically do not take the same query params as /run.
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sleep(ms: number) {

  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function coerceToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return null;

  // Some providers return a plain object (e.g., { choices: [...] })

  // If we can't find a known text field, avoid returning "[object Object]".
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function fingerprintSecret(value: string): string {
  // Non-reversible fingerprint for debugging env mismatches across deployments.

  // Safe to log (does not reveal the secret).
  try {

    return createHash("sha256").update(value).digest("hex").slice(0, 10);
  } catch {
    return "unknown";
  }
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


let cachedOpenAICompatModelId: string | null = null;
let cachedOpenAICompatModelIdAtMs = 0;

async function discoverOpenAICompatModelId(modelsUrl: string, authHeader: string): Promise<string | null> {

  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;
  if (cachedOpenAICompatModelId && now - cachedOpenAICompatModelIdAtMs < ttlMs) return cachedOpenAICompatModelId;


  try {
    const resp = await fetch(modelsUrl, {

      method: "GET",
      headers: { Authorization: authHeader },
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const id = typeof data?.data?.[0]?.id === "string" ? String(data.data[0].id) : null;
    if (!id) return null;
    cachedOpenAICompatModelId = id;
    cachedOpenAICompatModelIdAtMs = now;
    return id;
  } catch {
    return null;
  }

}

function buildRunpodOpenAICompatChatUrls(endpoint: string): string[] {
  // RunPod vLLM workers typically expose an OpenAI-compatible server at:
  // https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1/chat/completions
  // Some deployments use a vllm-prefixed endpoint id:
  // https://api.runpod.ai/v2/vllm-<ENDPOINT_ID>/openai/v1/chat/completions
  try {
    const url = new URL(endpoint);
    const parts = url.pathname.split("/").filter(Boolean);
    // Expect: ["v2", "<id>", "run"] or ["v2", "<id>", "runsync"]
    if (parts.length >= 2 && parts[0] === "v2") {

      const endpointId = parts[1];
      const base = `${url.protocol}//${url.host}`;
      return [
        `${base}/v2/${endpointId}/openai/v1/chat/completions`,
        `${base}/v2/vllm-${endpointId}/openai/v1/chat/completions`,
      ];
    }
    return [];
  } catch {
    return [];

  }
}

/**
 * Calls the RunPod serverless endpoint with DeepSeek vLLM model
 * @param messages - Array of chat messages in OpenAI format
 * @param maxTokens - Maximum tokens to generate (optional, defaults to 4000)
 * @returns The generated text content or null on error
 */
export async function callLLMResult(

  messages: Message[],
  maxTokens = 4000,
  temperature = 0.7,
  options?: CallLLMOptions
): Promise<CallLLMResult> {
  const endpoint = process.env.RUNPOD_ENDPOINT;
  const apiKey = process.env.RUNPOD_API_KEY;
  const model = process.env.RUNPOD_MODEL || "deepseek-r1";

  if (!endpoint || !apiKey) {
    console.error("[aiClient] RUNPOD_ENDPOINT or RUNPOD_API_KEY missing");

    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  const rawAuth = apiKey.trim();

  const bearerAuthHeaderValue = rawAuth.toLowerCase().startsWith("bearer ") ? rawAuth : `Bearer ${rawAuth}`;
  const rawAuthHeaderValue = rawAuth.replace(/^bearer\s+/i, "");

  const apiKeyFp = fingerprintSecret(rawAuthHeaderValue);

  const { normalizedPathname } = parseEndpoint(endpoint);
  const isAsyncRun = (normalizedPathname ?? endpoint).replace(/\/+$/, "").endsWith("/run");
  const wantsStructuredOutput = options?.responseFormat != null || options?.guidedJson != null;
  // OpenAI-compatible endpoints are often synchronous (long-lived HTTP requests).
  // For async /run endpoints, prefer the native /run + /status polling path to avoid
  // gateway/proxy timeouts on platforms like Vercel.
  const forceOpenAICompat = process.env.RUNPOD_OPENAI_COMPAT_FORCE === "1";
  // For async /run endpoints, OpenAI-compat is the only mode that reliably supports
  // structured output (`response_format: json_schema`) for some templates.
  // Allow disabling it (e.g. for platforms with strict outbound request timeouts).
  const allowOpenAICompatForAsyncStructured =
    isAsyncRun &&
    wantsStructuredOutput &&
    (forceOpenAICompat || process.env.RUNPOD_OPENAI_COMPAT_STRUCTURED !== "0");

  let useOpenAICompat =
    forceOpenAICompat ||
    allowOpenAICompatForAsyncStructured ||
    (!isAsyncRun &&
      (process.env.RUNPOD_OPENAI_COMPAT === "1" || process.env.RUNPOD_GUIDED_JSON === "1" || wantsStructuredOutput));

  if (options?.disableOpenAICompat) {
    useOpenAICompat = false;
  }

  console.log(
    `[aiClient] Transport decision: isAsyncRun=${isAsyncRun} wantsStructured=${wantsStructuredOutput} ` +
      `RUNPOD_OPENAI_COMPAT=${process.env.RUNPOD_OPENAI_COMPAT || "0"} ` +
      `RUNPOD_OPENAI_COMPAT_STRUCTURED=${process.env.RUNPOD_OPENAI_COMPAT_STRUCTURED || "(unset)"} ` +
      `RUNPOD_OPENAI_COMPAT_FORCE=${process.env.RUNPOD_OPENAI_COMPAT_FORCE || "0"} ` +
      `=> useOpenAICompat=${useOpenAICompat}`
  );
  // OpenAI-compat endpoints can be slower on cold starts and during queueing.
  // If the caller provides a timeout, respect it (don't cap it to the default).
  const defaultOpenAICompatTimeoutMs = Number(process.env.RUNPOD_OPENAI_COMPAT_TIMEOUT_MS || 90_000);
  const openAICompatTimeoutMs =
    typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Math.min(300_000, Math.floor(options.timeoutMs)))
      : Math.max(1_000, Math.min(300_000, Math.floor(defaultOpenAICompatTimeoutMs)));

  const defaultRunpodRunPostTimeoutMs = Math.max(1_000, Number(process.env.RUNPOD_RUN_POST_TIMEOUT_MS || 30_000));

  try {
    console.log(
      `[aiClient] Calling RunPod ${isAsyncRun ? "/run" : "/runsync"} at ${safeEndpointLabel(endpoint)} (model=${model})`
    );
    console.log(`[aiClient] RunPod key fingerprint: ${apiKeyFp}`);

    if (useOpenAICompat) {
      const explicitChatUrl = process.env.RUNPOD_OPENAI_COMPAT_CHAT_URL;
      const chatUrls = explicitChatUrl
        ? [explicitChatUrl]
        : buildRunpodOpenAICompatChatUrls(endpoint);

      if (!chatUrls.length) {
        console.warn("[aiClient] RUNPOD_OPENAI_COMPAT=1 but could not derive OpenAI-compatible URL from RUNPOD_ENDPOINT; falling back");
      } else {
        // vLLM OpenAI-compatible: allow structured output via response_format / json_schema.
        const responseFormat =
          options?.responseFormat ??
          (options?.guidedJson
            ? {
                type: "json_schema",
                json_schema: {
                  name: "flashcards",
                  schema: options.guidedJson,
                },
              }
            : undefined);

        const extraBody: Record<string, unknown> = {
          ...(options?.extraBody || {}),
        };

        // Some servers accept guided decoding controls only via an extra body.
        if (options?.guidedJson != null && extraBody.guided_json == null) extraBody.guided_json = options.guidedJson;
        if (process.env.RUNPOD_GUIDED_DECODING_BACKEND && extraBody.guided_decoding_backend == null) {
          extraBody.guided_decoding_backend = process.env.RUNPOD_GUIDED_DECODING_BACKEND;
        }

        for (const chatUrl of chatUrls) {
          console.log(`[aiClient] Using OpenAI-compatible endpoint: ${safeEndpointLabel(chatUrl)}`);
          const modelsUrl = chatUrl.replace(/\/chat\/completions\/?$/, "/models");

          // vLLM often requires the full model id (e.g. "deepseek-ai/deepseek-r1-distill-qwen-7b").
          // If RUNPOD_MODEL is a friendly alias (e.g. "deepseek-r1"), try to discover the served model id.
          let compatModel = process.env.RUNPOD_OPENAI_COMPAT_MODEL || model;
          const looksLikeFullId = compatModel.includes("/");
          let discoveredModelId: string | null = null;
          if (!looksLikeFullId && !process.env.RUNPOD_OPENAI_COMPAT_MODEL) {
            discoveredModelId = await discoverOpenAICompatModelId(modelsUrl, bearerAuthHeaderValue);
            if (discoveredModelId) {
              compatModel = discoveredModelId;
              console.log(`[aiClient] OpenAI-compat model id discovered: ${compatModel}`);
            }
          }

          const makeBody = (override: { model?: string; omitResponseFormat?: boolean }) =>
            JSON.stringify({
              model: override.model || compatModel,
              messages,
              max_tokens: maxTokens,
              temperature,
              ...(typeof options?.topP === "number" ? { top_p: options.topP } : {}),
              ...(Array.isArray(options?.stop) && options.stop.length ? { stop: options.stop } : {}),
              ...(!override.omitResponseFormat && responseFormat ? { response_format: responseFormat } : {}),
              ...(Object.keys(extraBody).length ? { extra_body: extraBody } : {}),
            });

          const doPost = async (body: string) =>
            fetchWithTimeout(
              chatUrl,
              {
                method: "POST",
                headers: {
                  Authorization: bearerAuthHeaderValue,
                  "Content-Type": "application/json",
                },
                body,
              },
              openAICompatTimeoutMs
            );

          let resp: Response;
          try {
            resp = await doPost(makeBody({}));
          } catch (e: any) {
            const msg = String(e?.message || e || "openai-compat request failed");
            if (String(e?.name || "").toLowerCase() === "aborterror") {
              console.warn(`[aiClient] OpenAI-compatible request timed out (AbortError): ${msg}`);
              return { ok: false, reason: "TIMEOUT", lastStatus: "OPENAI_COMPAT_TIMEOUT" };
            }

            // Non-timeout failures can still fall back to /run.
            console.warn(`[aiClient] OpenAI-compatible request threw (${e?.name || "Error"}): ${msg}. Falling back to /run.`);
            break;
          }

          if (resp.ok) {
            const data = await resp.json();
            const content = extractTextFromRunpodOutput(data);
            if (!content) return { ok: false, reason: "EMPTY_OUTPUT" };
            console.log(`[aiClient] Generated ${content.length} characters (openai-compat)`);
            return { ok: true, content };
          }

          const errorText = await resp.text().catch(() => "");
          const status = resp.status;

          // 404/405 typically means this compat route doesn't exist for this deployment.
          if (status === 404 || status === 405) {
            console.warn(
              `[aiClient] OpenAI-compatible endpoint not available (${status}) at ${safeEndpointLabel(chatUrl)}; trying next pattern`
            );
            continue;
          }

          // Retry: if server errors, try switching to discovered model id (if we didn't already),
          // and/or drop response_format (some deployments error on json_schema even when guided_json works).
          if ((status === 500 || status === 400) && responseFormat) {
            if (!discoveredModelId) {
              const id = await discoverOpenAICompatModelId(modelsUrl, bearerAuthHeaderValue);
              if (id && id !== compatModel) {
                console.warn(`[aiClient] Retrying openai-compat with discovered model id after ${status}`);
                try {
                  resp = await doPost(makeBody({ model: id }));
                } catch (e: any) {
                  const msg = String(e?.message || e || "openai-compat retry failed");
                  console.warn(`[aiClient] OpenAI-compatible retry threw (${e?.name || "Error"}): ${msg}. Falling back to /run.`);
                  break;
                }
                if (resp.ok) {
                  const data = await resp.json();
                  const content = extractTextFromRunpodOutput(data);
                  if (!content) return { ok: false, reason: "EMPTY_OUTPUT" };
                  console.log(`[aiClient] Generated ${content.length} characters (openai-compat, retry-model)`);
                  return { ok: true, content };
                }
              }
            }

            console.warn(`[aiClient] Retrying openai-compat without response_format after ${status}`);
            try {
              resp = await doPost(makeBody({ omitResponseFormat: true }));
            } catch (e: any) {
              const msg = String(e?.message || e || "openai-compat retry failed");
              console.warn(`[aiClient] OpenAI-compatible retry threw (${e?.name || "Error"}): ${msg}. Falling back to /run.`);
              break;
            }
            if (resp.ok) {
              const data = await resp.json();
              const content = extractTextFromRunpodOutput(data);
              if (!content) return { ok: false, reason: "EMPTY_OUTPUT" };
              console.log(`[aiClient] Generated ${content.length} characters (openai-compat, no-response-format)`);
              return { ok: true, content };
            }
          }

          console.warn(
            `[aiClient] OpenAI-compatible call failed (${status}); falling back to /run. Body: ${String(errorText || "").slice(0, 300)}`
          );
          break;
        }
      }
    }

    const input: any = {
      model: model,
      messages: messages,
      max_tokens: maxTokens,
      temperature,
    };

    if (typeof options?.topP === "number") input.top_p = options.topP;
    if (Array.isArray(options?.stop) && options!.stop!.length > 0) input.stop = options!.stop;

    // Some vLLM/RunPod templates support JSON-schema/grammar guidance via `guided_json`.
    // Others only accept these controls when nested under `extra_body`.
    // To maximize compatibility, when structured controls are provided, send them in both places.
    // Prefer passing raw JSON (object/array) rather than a stringified schema.
    const extraBody: Record<string, unknown> = {
      ...(options?.extraBody || {}),
    };

    if (options?.guidedJson != null) {
      input.guided_json = options.guidedJson;
      if (extraBody.guided_json == null) extraBody.guided_json = options.guidedJson;
      if (process.env.RUNPOD_GUIDED_DECODING_BACKEND && extraBody.guided_decoding_backend == null) {
        extraBody.guided_decoding_backend = process.env.RUNPOD_GUIDED_DECODING_BACKEND;
      }
    }

    // Some templates ignore `guided_json` but support OpenAI-style structured output controls.
    // If the caller provided guidedJson and did not provide an explicit responseFormat, derive one.
    if (options?.guidedJson != null && options?.responseFormat == null) {
      const derivedResponseFormat = {
        type: "json_schema",
        json_schema: {
          name: "flashcards",
          schema: options.guidedJson,
        },
      };
      input.response_format = derivedResponseFormat;
      if (extraBody.response_format == null) extraBody.response_format = derivedResponseFormat;
    }

    if (options?.responseFormat != null) {
      input.response_format = options.responseFormat;
      if (extraBody.response_format == null) extraBody.response_format = options.responseFormat;
    }

    if (Object.keys(extraBody).length) {
      input.extra_body = extraBody;
    }

    const body = JSON.stringify({ input });

    const doPost = async (authorizationValue: string) =>
      fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: authorizationValue,
            "Content-Type": "application/json",
          },
          body,
        },
        // /run should respond quickly (job id); don't let submission hang indefinitely.
        Math.min(
          300_000,
          typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
            ? Math.max(1_000, Math.floor(options.timeoutMs))
            : defaultRunpodRunPostTimeoutMs
        )
      );

    // RunPod generally expects Bearer auth, but some users paste tokens in different formats.
    // If we get a 401, retry once with the alternate format to rule out header formatting.
    let authUsed = bearerAuthHeaderValue;
    let resp = await doPost(authUsed);
    if (resp.status === 401) {
      const alternate = authUsed === bearerAuthHeaderValue ? rawAuthHeaderValue : bearerAuthHeaderValue;
      console.warn("[aiClient] RunPod returned 401; retrying once with alternate Authorization format");
      authUsed = alternate;
      resp = await doPost(authUsed);
    }

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      console.error(
        `[aiClient] RunPod API error: ${resp.status} ${String(errorText || "").slice(0, 500)}`
      );
      return {
        ok: false,
        reason: "HTTP_ERROR",
        httpStatus: resp.status,
        message: String(errorText || "").slice(0, 500),
      };
    }

    const data = await resp.json();

    // If using /run (async), poll /status/<id> until completion.
    let resolved = data as any;
    if (isAsyncRun) {
      const jobId = resolved?.id;
      if (!jobId) {
        console.error("[aiClient] RunPod /run response missing job id");
        return { ok: false, reason: "HTTP_ERROR", message: "RunPod /run response missing job id" };
      }

      console.log(`[aiClient] RunPod async job started (id=${jobId})`);

      const statusUrl = buildRunpodStatusUrl(endpoint, String(jobId));
      const startedAt = Date.now();
      // Default close to (but under) typical serverless max duration.
      const defaultAsyncTimeoutMs = Math.max(15_000, Number(process.env.RUNPOD_ASYNC_TIMEOUT_MS || 240_000));
      const requestedTimeoutMs =
        typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
          ? Math.floor(options.timeoutMs)
          : null;
      // Respect caller timeouts; cap only to a hard safety limit.
      const timeoutMs = requestedTimeoutMs
        ? Math.max(15_000, Math.min(300_000, requestedTimeoutMs))
        : Math.min(300_000, defaultAsyncTimeoutMs);
      const intervalMs = Math.max(250, Number(process.env.RUNPOD_ASYNC_POLL_INTERVAL_MS || 1500));
      let pollCount = 0;
      let lastStatus = "";

      while (Date.now() - startedAt < timeoutMs) {
        pollCount++;
        const statusResp = await fetch(statusUrl, {
          method: "GET",
          headers: { Authorization: authUsed },
        });

        if (!statusResp.ok) {
          const statusText = await statusResp.text().catch(() => "");
          console.error(
            `[aiClient] RunPod status error: ${statusResp.status} ${String(statusText || "").slice(0, 500)}`
          );
          return {
            ok: false,
            reason: "STATUS_HTTP_ERROR",
            httpStatus: statusResp.status,
            jobId: String(jobId),
            message: String(statusText || "").slice(0, 500),
          };
        }

        resolved = await statusResp.json();
        const status = String(resolved?.status || "").toUpperCase();
        lastStatus = status;

        if (pollCount % 5 === 0 && status && status !== "COMPLETED") {
          console.log(
            `[aiClient] RunPod async job status (id=${jobId}, poll=${pollCount}, ms=${Date.now() - startedAt}): ${status}`
          );
        }

        if (status === "COMPLETED") break;
        if (status === "FAILED" || status === "CANCELLED") {
          console.error("[aiClient] RunPod job failed:", coerceToString(resolved?.error) || "unknown error");
          return {
            ok: false,
            reason: "JOB_FAILED",
            jobId: String(jobId),
            lastStatus: status,
            message: coerceToString(resolved?.error) || "unknown error",
          };
        }

        await sleep(intervalMs);
      }

      if (String(resolved?.status || "").toUpperCase() !== "COMPLETED") {
        console.error("[aiClient] RunPod job timed out waiting for completion");
        return {
          ok: false,
          reason: "TIMEOUT",
          jobId: String(jobId),
          lastStatus: lastStatus || String(resolved?.status || ""),
          message: "RunPod job timed out waiting for completion",
        };
      }

      console.log(
        `[aiClient] RunPod async job completed (id=${jobId}, polls=${pollCount}, ms=${Date.now() - startedAt})`
      );

      const content = extractTextFromRunpodOutput(resolved?.output);
      if (!content) {
        console.error("[aiClient] Empty response from RunPod");
        return { ok: false, reason: "EMPTY_OUTPUT", jobId: String(jobId) };
      }

      console.log(`[aiClient] Generated ${content.length} characters`);
      return { ok: true, content, jobId: String(jobId) };
    }

    const content = extractTextFromRunpodOutput(resolved?.output);
    if (!content) {
      console.error("[aiClient] Empty response from RunPod");
      return { ok: false, reason: "EMPTY_OUTPUT" };
    }

    console.log(`[aiClient] Generated ${content.length} characters`);
    return { ok: true, content };
  } catch (err: any) {
    if (String(err?.name || "") === "AbortError") {
      console.error("[aiClient] LLM request timed out (AbortError)");
      return { ok: false, reason: "TIMEOUT", message: "LLM request timed out" };
    }
    console.error("[aiClient] RunPod error:", err.message);
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
