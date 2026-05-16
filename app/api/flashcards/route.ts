/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { callLLMResult } from "@/lib/aiClient";
import { put } from "@vercel/blob";
import { transcribeAudioUrlWithRunpod } from "@/lib/asrClient";
import { transcribeYoutubeUrlWithRunpod } from "@/lib/runpodYoutubeClient";
import { transcribeYoutubeViaAsrWorker } from "@/lib/youtubeAsrWorkerClient";
import { fetchSupadataTranscript, hasSupadataConfigured } from "@/lib/supadata";
import { parseYouTube } from "@/lib/youtube";
import { createReasoningEngine } from "@/lib/reasoningEngine/engine";
import { persistFlashcardReasoningRun } from "@/lib/reasoningEngine/persistence";
import { getStudentKnowledgeState } from "@/lib/reasoningEngine/studentState";

export const runtime = "nodejs";         // node runtime to allow larger bodies locally
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODEL = "gpt-4o-mini";
const MAX_SOURCE_CHARS = 20_000;
const MAX_LLM_SOURCE_CHARS = Number(process.env.MAX_LLM_SOURCE_CHARS || 8000);
const DEFAULT_CARD_COUNT = 20;
const MIN_CARD_COUNT = 10;
const STRICT_VIDEO = process.env.STRICT_VIDEO === "1";
// Cost guardrails
const DISABLE_AUDIO_UPLOAD = process.env.DISABLE_AUDIO_UPLOAD === "1";
// Option 1: Disable "paste YouTube URL" ingestion by default for reliability.
// Set DISABLE_YOUTUBE_URLS=0 to re-enable.
const DISABLE_YOUTUBE_URLS = process.env.DISABLE_YOUTUBE_URLS !== "0";
// Legacy YouTube scraping/download fallbacks are unreliable on Vercel and can cause long timeouts.
// Only enable explicitly.
const YOUTUBE_ALLOW_LEGACY_FALLBACKS = process.env.YOUTUBE_ALLOW_LEGACY_FALLBACKS === "1";
// Default higher than 1200: structured JSON for 20+ cards can otherwise truncate mid-object,
// producing invalid JSON and failing parsing.
const OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 2600);
const MAX_DECKS_PER_DAY = Number(process.env.MAX_DECKS_PER_DAY || 50);

const MAX_Q_CHARS = Number(process.env.FLASHCARDS_MAX_Q_CHARS || 140);
const MAX_A_CHARS = Number(process.env.FLASHCARDS_MAX_A_CHARS || 220);
const reasoningEngine = createReasoningEngine({
  beamWidth: Number(process.env.REASONING_ENGINE_BEAM_WIDTH || 3),
  maxAttempts: Number(process.env.REASONING_ENGINE_MAX_ATTEMPTS || 3),
});

function cleanText(s: string) { return s.replace(/\s+/g, " ").trim(); }
function truncate(s: string, max = MAX_SOURCE_CHARS) { return s.length > max ? s.slice(0, max) : s; }

function shrinkSourceForLLM(text: string, maxChars: number): string {
  const t = String(text || "").trim();
  if (!t || t.length <= maxChars) return t;

  // PPTX extraction uses markers like: [Slide 12] ...
  // For large decks, sending the full 20k chars every batch is slow.
  // Keep a representative slice per slide until we hit the budget.
  if (/\[Slide\s+\d+\]/i.test(t)) {
    const chunks = t.match(/\[Slide\s+\d+\][\s\S]*?(?=\[Slide\s+\d+\]|$)/gi) || [];
    let out = "";
    for (const chunk of chunks) {
      const c = chunk.replace(/\s+/g, " ").trim();
      if (!c) continue;
      const clipped = c.length > 320 ? `${c.slice(0, 320)}…` : c;
      const next = out ? `${out}\n${clipped}` : clipped;
      if (next.length > maxChars) break;
      out = next;
    }
    if (out) return out;
  }

  return t.slice(0, maxChars);
}

function formatTranscriptAsSlides(transcript: string, opts?: { maxTotalChars?: number; slides?: number; maxCharsPerSlide?: number }): string {
  const raw = String(transcript || "").trim();
  if (!raw) return "";

  const maxTotalChars = Math.max(1000, Math.floor(opts?.maxTotalChars ?? MAX_SOURCE_CHARS));
  const maxCharsPerSlide = Math.max(200, Math.floor(opts?.maxCharsPerSlide ?? 700));
  const desiredSlides = Math.max(8, Math.min(40, Math.floor(opts?.slides ?? (raw.length > maxTotalChars ? 40 : Math.ceil(raw.length / 1200)))));

  const parts: string[] = [];
  const L = raw.length;
  for (let i = 0; i < desiredSlides; i++) {
    const start = Math.floor((i * L) / desiredSlides);
    const end = Math.floor(((i + 1) * L) / desiredSlides);
    const segment = cleanText(raw.slice(start, end));
    if (!segment) continue;
    const clipped = segment.length > maxCharsPerSlide ? `${segment.slice(0, maxCharsPerSlide)}…` : segment;
    parts.push(`[Slide ${parts.length + 1}] ${clipped}`);
    if (parts.join("\n").length >= maxTotalChars) break;
  }

  const out = parts.join("\n").trim();
  return out.length > maxTotalChars ? out.slice(0, maxTotalChars) : out;
}
function isYouTubeHostname(host: string) { return ["www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"].includes(host); }
function getYouTubeId(u: URL) {
  if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
  if (u.searchParams.get("v")) return u.searchParams.get("v")!;
  const m = u.pathname.match(/\/shorts\/([^/]+)/);
  return m?.[1] || null;
}
function guessKindFromNameType(name?: string, type?: string): "pdf" | "pptx" | "unknown" {
  const nm = (name || "").toLowerCase();
  const tp = (type || "").toLowerCase();
  if (nm.endsWith(".pdf") || tp === "application/pdf") return "pdf";
  if (nm.endsWith(".pptx") || tp === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  return "unknown";
}
const stripFence = (s: string) => s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

// Repair a common model failure: emitting literal newlines inside JSON strings.
// JSON does not allow raw \n/\r characters inside quoted strings; they must be escaped.
function repairJsonNewlinesInStrings(s: string): string {
  const input = String(s || "");
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }

      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }

      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        // Drop CR; if this is a CRLF pair, the LF will become \n.
        continue;
      }

      // JSON forbids unescaped control characters (U+0000..U+001F) inside strings.
      // Also escape common Unicode line separators that can break parsers.
      const code = ch.charCodeAt(0);
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      if (ch === "\u2028") {
        out += "\\u2028";
        continue;
      }
      if (ch === "\u2029") {
        out += "\\u2029";
        continue;
      }
      if (code >= 0 && code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }

      out += ch;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = true;
      continue;
    }

    out += ch;
  }

  return out;
}

function extractFirstJsonArray(s: string): string | null {
  const start = s.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  return null;
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  return null;
}

// Similar to extractFirstJsonArray, but tolerant of truncated output.
// If we can find at least one complete top-level object within the first array,
// return a valid JSON array containing only the completed elements.
function extractFirstJsonArrayPrefix(s: string): string | null {
  const start = s.indexOf("[");
  if (start === -1) return null;

  let inString = false;
  let escaped = false;
  let arrayDepth = 0;
  let objectDepth = 0;
  let lastCompleteElementEnd = -1;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "[") arrayDepth++;
    if (ch === "]") {
      arrayDepth--;
      if (arrayDepth === 0) return s.slice(start, i + 1);
      continue;
    }

    if (ch === "{") objectDepth++;
    if (ch === "}") {
      objectDepth--;
      // Completed a top-level element inside the first array.
      if (arrayDepth === 1 && objectDepth === 0) {
        lastCompleteElementEnd = i;
      }
    }
  }

  if (lastCompleteElementEnd !== -1) {
    return `${s.slice(start, lastCompleteElementEnd + 1)}]`;
  }

  return null;
}

async function fetchYouTubeTranscriptViaYtdlCore(id: string): Promise<string | null> {
  try {
    const ytdl = (await import("ytdl-core")) as any;
    const ytdlDefault = ytdl.default ?? ytdl;
    const watchUrl = `https://www.youtube.com/watch?v=${id}`;
    const requestOptions = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };

    const info = await (ytdlDefault.getInfo
      ? ytdlDefault.getInfo(watchUrl, { requestOptions })
      : ytdl.getInfo(watchUrl, { requestOptions }));
    const pr =
      info.player_response ||
      (typeof info.player_response === "string" ? JSON.parse(info.player_response) : info.player_response) ||
      info.playerResponse;

    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || !tracks.length) return null;

    const track = tracks.find((t: any) => t.languageCode === "en") || tracks[0];
    const baseUrl: string = track.baseUrl;

    const captionFetchHeaders = {
      "User-Agent": requestOptions.headers["User-Agent"],
      "Accept-Language": requestOptions.headers["Accept-Language"],
    };

    // Try JSON3
    try {
      const r = await fetch(baseUrl + "&fmt=json3", { headers: captionFetchHeaders });
      if (r.ok) {
        const j: any = await r.json();
        const text = (j.events || [])
          .map((ev: any) => (ev.segs || []).map((s: any) => s.utf8 || "").join(""))
          .join(" ");
        const cleaned = String(text || "").replace(/\s+/g, " ").trim();
        if (cleaned) return cleaned;
      }
    } catch {
      // ignore
    }

    // Fallback XML timedtext
    try {
      const r2 = await fetch(baseUrl, { headers: captionFetchHeaders });
      if (r2.ok) {
        const xml = await r2.text();
        const matches = Array.from(xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g));
        const text = matches
          .map((m: any) =>
            String(m[1] || "")
              .replace(/&amp;/g, "&")
              .replace(/&#39;/g, "'")
              .replace(/&quot;/g, '"')
              .replace(/&gt;/g, ">")
              .replace(/&lt;/g, "<")
          )
          .join(" ");
        const cleaned = String(text || "").replace(/\s+/g, " ").trim();
        if (cleaned) return cleaned;
      }
    } catch {
      // ignore
    }

    return null;
  } catch (e) {
    console.warn("[YouTube] ytdl-core fallback failed:", (e as any)?.message || e);
    return null;
  }
}

async function fetchYouTubeTranscriptViaTimedText(id: string): Promise<string | null> {
  // Direct caption fetch that avoids ytdl-core parsing and avoids audio downloads.
  // Works when captions (including auto captions) are available via timedtext.
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
  const headers = {
    "User-Agent": ua,
    "Accept-Language": "en-US,en;q=0.9",
    // Prefer caption formats, not HTML.
    Accept: "text/vtt,application/xml,text/xml,application/json,*/*;q=0.8",
    Referer: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
  };

  // First try to discover which caption tracks exist (language + manual vs ASR).
  // This dramatically improves success vs hardcoding lang=en.
  type Track = { lang: string; name?: string; isAsr: boolean };
  const listUrls = [
    `https://video.google.com/timedtext?type=list&v=${encodeURIComponent(id)}`,
    `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(id)}`,
  ];

  async function fetchTrackList(): Promise<Track[]> {
    for (const listUrl of listUrls) {
      try {
        const r = await fetch(listUrl, { headers });
        if (!r.ok) continue;
        const xml = await r.text();
        if (!xml || xml.trim().length < 10) continue;

        const tracks: Track[] = [];
        const re = /<track\b([^>]*)\/?>(?:<\/track>)?/gi;
        for (const m of xml.matchAll(re)) {
          const attrs = String(m[1] || "");
          const lang = (attrs.match(/\blang_code="([^"]+)"/i)?.[1] || "").trim();
          if (!lang) continue;
          const name = (attrs.match(/\bname="([^"]*)"/i)?.[1] || "").trim();
          const kind = (attrs.match(/\bkind="([^"]+)"/i)?.[1] || "").trim().toLowerCase();
          tracks.push({ lang, name: name || undefined, isAsr: kind === "asr" });
        }

        if (tracks.length) return tracks;
      } catch {
        // ignore and try next list url
      }
    }

    return [];
  }

  function buildTimedtextUrl(track: Track, fmt: "vtt" | "xml"): string {
    const base = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&lang=${encodeURIComponent(track.lang)}`;
    const name = track.name ? `&name=${encodeURIComponent(track.name)}` : "";
    const kind = track.isAsr ? "&kind=asr" : "";
    const format = fmt === "vtt" ? "&fmt=vtt" : "";
    return `${base}${name}${kind}${format}`;
  }

  function parseJson3ToText(json: any): string {
    const events = Array.isArray(json?.events) ? json.events : [];
    const parts: string[] = [];
    for (const ev of events) {
      const segs = Array.isArray(ev?.segs) ? ev.segs : [];
      for (const seg of segs) {
        const t = typeof seg?.utf8 === "string" ? seg.utf8 : "";
        if (t) parts.push(t);
      }
    }
    return cleanText(parts.join(" "));
  }

  const tracks = await fetchTrackList();
  const preferred: Track[] = [];

  if (tracks.length) {
    const byExact = (lang: string, isAsr: boolean) => tracks.filter((t) => t.lang === lang && t.isAsr === isAsr);
    const byPrefix = (prefix: string, isAsr: boolean) => tracks.filter((t) => t.lang.startsWith(prefix) && t.isAsr === isAsr);
    // Prefer English manual captions, then English ASR. Include en-* locales.
    preferred.push(...byExact("en", false), ...byPrefix("en-", false));
    preferred.push(...byExact("en", true), ...byPrefix("en-", true));
    // Then any manual captions, then any ASR captions.
    preferred.push(...tracks.filter((t) => !t.lang.startsWith("en") && !t.isAsr));
    preferred.push(...tracks.filter((t) => !t.lang.startsWith("en") && t.isAsr));

    // Fetch each track (try VTT first, then XML, then json3)
    for (const track of preferred) {
      for (const fmt of ["vtt", "xml"] as const) {
        const url = buildTimedtextUrl(track, fmt);
        try {
          const r = await fetch(url, { headers });
          if (!r.ok) continue;
          const contentType = (r.headers.get("content-type") || "").toLowerCase();
          const body = await r.text();
          if (!body || body.trim().length < 10) continue;

          if (contentType.includes("text/vtt") || /^WEBVTT/i.test(body.trim())) {
            const cleaned = parseSubtitleBuffer(Buffer.from(body, "utf8"));
            if (cleaned) return cleaned;
            continue;
          }

          const matches = Array.from(body.matchAll(/<text[^>]*>([^<]*)<\/text>/g));
          const text = matches
            .map((m: any) =>
              String(m[1] || "")
                .replace(/&amp;/g, "&")
                .replace(/&#39;/g, "'")
                .replace(/&quot;/g, '"')
                .replace(/&gt;/g, ">")
                .replace(/&lt;/g, "<")
            )
            .join(" ");
          const cleaned = cleanText(text || "");
          if (cleaned) return cleaned;
        } catch {
          // ignore and try next
        }
      }

      // json3 captions (common alternative when XML/VTT isn't returned)
      try {
        const url = `${buildTimedtextUrl(track, "xml")}&fmt=json3`;
        const r = await fetch(url, { headers });
        if (!r.ok) continue;
        const json = await r.json().catch(() => null);
        const cleaned = parseJson3ToText(json);
        if (cleaned) return cleaned;
      } catch {
        // ignore
      }
    }
  }

  const candidates = [
    // Manual captions
    `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&lang=en&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&lang=en`,
    // Auto captions (ASR)
    `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&lang=en&kind=asr&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(id)}&lang=en&kind=asr`,
  ];

  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const contentType = (r.headers.get("content-type") || "").toLowerCase();
      const body = await r.text();
      if (!body || body.trim().length < 10) continue;

      // If VTT, reuse our subtitle parsing.
      if (contentType.includes("text/vtt") || /^WEBVTT/i.test(body.trim())) {
        const cleaned = parseSubtitleBuffer(Buffer.from(body, "utf8"));
        if (cleaned) return cleaned;
        continue;
      }

      // XML timedtext
      const matches = Array.from(body.matchAll(/<text[^>]*>([^<]*)<\/text>/g));
      const text = matches
        .map((m: any) =>
          String(m[1] || "")
            .replace(/&amp;/g, "&")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&gt;/g, ">")
            .replace(/&lt;/g, "<")
        )
        .join(" ");
      const cleaned = cleanText(text || "");
      if (cleaned) return cleaned;
    } catch {
      // ignore and try next
    }
  }

  return null;
}

async function downloadYouTubeAudioBufferViaYtdlCore(
  id: string,
  maxBytes: number
): Promise<{ buf: Buffer; filename: string; contentType: string }> {
  const ytdl = (await import("ytdl-core")) as any;
  const ytdlDefault = ytdl.default ?? ytdl;

  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  const requestOptions = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  };

  const info = await (ytdlDefault.getInfo
    ? ytdlDefault.getInfo(watchUrl, { requestOptions })
    : ytdl.getInfo(watchUrl, { requestOptions }));
  const format = ytdlDefault.chooseFormat
    ? ytdlDefault.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" })
    : (ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" }) as any);

  const mimeTypeRaw: string | undefined = format?.mimeType;
  const contentType = (mimeTypeRaw ? String(mimeTypeRaw).split(";")[0] : "audio/webm") || "audio/webm";
  const ext = contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : "webm";
  const filename = `youtube-${id}.${ext}`;

  const stream = ytdlDefault(watchUrl, {
    quality: format.itag,
    requestOptions,
    highWaterMark: 1 << 25,
  });

  const chunks: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy(new Error(`YouTube audio too large (> ${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve());
    stream.on("error", (e: any) => reject(e));
  });

  return { buf: Buffer.concat(chunks), filename, contentType };
}

async function extractFromYouTubeStrict(u: URL): Promise<{ title: string; text: string }> {
  const id = getYouTubeId(u);
  if (!id) throw new Error("Could not parse YouTube video ID.");

  // 1) Try yt-dlp subtitle download (most reliable method)
  try {
    console.log("[YouTube] Attempting yt-dlp subtitle download for:", id);
    const { downloadYouTubeSubtitles, parseVTT } = await import("@/lib/fallback/yt-dlp");
    const { readFileSync } = await import("fs");
    
    const subtitlePath = await downloadYouTubeSubtitles(id, {
      lang: "en",
      format: "vtt"
    });
    
    const vttContent = readFileSync(subtitlePath, "utf-8");
    const cues = parseVTT(vttContent);
    
    if (cues && cues.length > 0) {
      const text = cues.map(c => c.text).join(" ");
      const cleaned = cleanText(text || "");
      if (cleaned) {
        console.log(`[YouTube] yt-dlp succeeded: ${cues.length} caption segments, ${cleaned.length} chars`);
        return { title: `YouTube ${id}`, text: cleaned };
      }
    }
  } catch (err) {
    console.warn("[YouTube] yt-dlp subtitle download failed:", (err as any)?.message || err);
  }

  // 2) Fallback: Try youtube-transcript library (may not work reliably)
  try {
    const { YoutubeTranscript } = (await import("youtube-transcript")) as any;
    const items =
      (await YoutubeTranscript.fetchTranscript(id).catch(() => null)) ??
      (await YoutubeTranscript.fetchTranscript(id, { lang: "en" }).catch(() => null));
    const text = Array.isArray(items) ? items.map((i: any) => i.text).join(" ") : "";
    const cleaned = cleanText(text || "");
    if (cleaned) {
      console.log("[YouTube] youtube-transcript library succeeded");
      return { title: `YouTube ${id}`, text: cleaned };
    }
  } catch (err) {
    console.warn("[YouTube] youtube-transcript library failed:", (err as any)?.message || err);
  }

  // 2a) Direct timedtext endpoints (manual captions or auto captions)
  try {
    const tt = await fetchYouTubeTranscriptViaTimedText(id);
    if (tt) {
      console.log("[YouTube] timedtext captions succeeded");
      return { title: `YouTube ${id}`, text: cleanText(tt) };
    }
  } catch (err) {
    console.warn("[YouTube] timedtext captions failed:", (err as any)?.message || err);
  }

  // 1a) Try scraping the watch page HTML for ytInitialPlayerResponse -> captions
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${id}`;
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const htmlRes = await fetch(watchUrl, { headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" } }).catch(() => null);
    if (htmlRes && htmlRes.ok) {
      const html = await htmlRes.text();
      // Look for ytInitialPlayerResponse JSON in HTML
      const patterns = [
        /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;\s*var/,
        /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;\s*function/,
        /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;\s*if/,
        /window\["ytInitialPlayerResponse"\]\s*=\s*(\{[\s\S]*?\})\s*;/,
        /var\s+ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;/,
      ];
      let prObj: any = null;
      for (const p of patterns) {
        const m = html.match(p as RegExp);
        if (m && m[1]) {
          try { prObj = JSON.parse(m[1]); break; } catch { /* try next */ }
        }
      }
      // fallback: search for "player_response":"{...}" style (escaped)
      if (!prObj) {
        const esc = html.match(/"player_response"\s*:\s*"(\{[\s\S]*?\})"/);
        if (esc && esc[1]) {
          try { prObj = JSON.parse(esc[1].replace(/\\n/g, "").replace(/\\"/g, '"')); } catch {}
        }
      }
      if (prObj) {
        const tracks = prObj?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks && tracks.length) {
          const track = tracks.find((t: any) => t.languageCode === "en") || tracks[0];
          const baseUrl: string = track.baseUrl;
          try {
            const r = await fetch(baseUrl + "&fmt=json3");
            if (r.ok) {
              const j = await r.json();
              const text = (j.events || []).map((ev: any) => (ev.segs || []).map((s: any) => s.utf8 || "").join("")).join(" ");
              const cleaned = cleanText(text || "");
              if (cleaned) return { title: `YouTube ${id}`, text: cleaned };
            }
          } catch (e) { /* ignore and continue to other strategies */ }
          try {
            const r2 = await fetch(baseUrl);
            if (r2.ok) {
              const xml = await r2.text();
              const matches = Array.from(xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g));
              const text = matches.map((m: any) => m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')).join(' ');
              const cleaned = cleanText(text || "");
              if (cleaned) return { title: `YouTube ${id}`, text: cleaned };
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    console.warn('[YouTube] HTML scrape for captions failed:', (e as any)?.message || e);
  }

  // 1b) Try to extract captions from player_response via ytdl-core (more robust for some videos)
  try {
    const ytdl = (await import("ytdl-core")) as any;
    const ytdlDefault = ytdl.default ?? ytdl;
    const target = u.toString();
    const requestOptions = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };
    try {
      const info = await (ytdlDefault.getInfo
        ? ytdlDefault.getInfo(target, { requestOptions })
        : ytdl.getInfo(target, { requestOptions }));
      const pr = info.player_response || (typeof info.player_response === "string" ? JSON.parse(info.player_response) : info.player_response) || info.playerResponse;
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length) {
        // prefer English if available
        const track = tracks.find((t: any) => t.languageCode === "en") || tracks[0];
        const baseUrl: string = track.baseUrl;
        const captionFetchHeaders = {
          "User-Agent": requestOptions.headers["User-Agent"],
          "Accept-Language": requestOptions.headers["Accept-Language"],
        };
        // try JSON3 first
        try {
          const r = await fetch(baseUrl + "&fmt=json3", { headers: captionFetchHeaders });
          if (r.ok) {
            const j = await r.json();
            const text = (j.events || []).map((ev: any) => (ev.segs || []).map((s: any) => s.utf8 || "").join("")).join(" ");
            const cleaned = cleanText(text || "");
            if (cleaned) return { title: `YouTube ${id}`, text: cleaned };
          }
        } catch {}
        // fallback to XML timedtext
        try {
          const r2 = await fetch(baseUrl, { headers: captionFetchHeaders });
          if (r2.ok) {
            const xml = await r2.text();
            const matches = Array.from(xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g));
            const text = matches.map((m: any) => m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<')).join(' ');
            const cleaned = cleanText(text || "");
            if (cleaned) return { title: `YouTube ${id}`, text: cleaned };
          }
        } catch (e) { /* ignore */ }
      }
    } catch (ie) {
      console.warn("[YouTube] ytdl-core getInfo failed:", (ie as any)?.message || ie);
    }
  } catch (e) {
    console.warn("[YouTube] ytdl-core captions fetch failed:", (e as any)?.message || e);
  }

  // 2) If captions unavailable, attempt to download audio and transcribe.
  try {
    const ytdl = (await import("ytdl-core")) as any;
    const stream = ytdl(id, { filter: "audioonly", quality: "lowestaudio" });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const buf = Buffer.concat(chunks);
    console.log("[YouTube] Downloaded audio size:", buf.length);
    const text = await transcribeBuffer(buf, "youtube.mp3", "audio/mpeg");
    const cleaned = cleanText(text || "");
    if (!cleaned) throw new Error("Transcription returned empty text.");
    return { title: `YouTube ${id}`, text: cleaned };
  } catch (e: any) {
    console.error("[YouTube] Audio transcription fallback failed:", e?.message || e);
    throw new Error("This YouTube video has no accessible captions and audio transcription failed.");
  }
}

async function extractFromWebsite(u: URL): Promise<{ title: string; text: string } | null> {
  try {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const res = await fetch(u.toString(), { headers: { "User-Agent": ua } });
    if (!res.ok) return null;
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = cleanText(titleMatch?.[1] || u.hostname);
    const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
    const text = cleanText(noScript.replace(/<[^>]+>/g, " "));
    return text ? { title, text } : null;
  } catch { return null; }
}

// Parse subtitle buffers (SRT or VTT) into plain text
function parseSubtitleBuffer(buf: Buffer): string {
  const s = buf.toString("utf8");
  // Remove WEBVTT header
  let t = s.replace(/^WEBVTT[\s\S]*?\n\n/, "");
  // Remove SRT numeric indexes and timestamps
  t = t.replace(/^[0-9]+\s*\n/gm, "");
  t = t.replace(/\d{2}:\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[\.,]\d{3}/g, "");
  // Remove VTT timestamps
  t = t.replace(/\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}\.\d{3}/g, "");
  // Remove remaining tag-like constructs
  t = t.replace(/<[^>]+>/g, "");
  // Collapse whitespace
  return cleanText(t);
}

async function extractPdfTextFromBuffer(buf: Buffer): Promise<string> {
  try {
    // Direct import of pdf-parse/lib/pdf-parse.js to avoid the test file issue
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    
    console.log("[PDF] Starting extraction, buffer size:", buf.length);
    const data = await pdfParse(buf, {
      max: 0 // No page limit
    });
    
    if (!data?.text) {
      console.error("[PDF] No text content found in PDF");
      return "";
    }
    
    const text = cleanText(data.text);
    console.log("[PDF] Extraction complete");
    console.log("[PDF] Extracted text length:", text.length);
    console.log("[PDF] Sample of extracted text:", text.slice(0, 200));
    
    // Additional validation
    if (text.length < 50) {
      console.warn("[PDF] Extracted text is suspiciously short:", text);
      return "";
    }
    
    return text;
  } catch (error) {
    console.error("[PDF] Error extracting text:", error);
    if (error instanceof Error) {
      console.error("[PDF] Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
    return ""; 
  }
}
async function extractPptxTextFromBuffer(buf: Buffer): Promise<string> {
  try {
    console.log("[PPTX] Starting extraction, buffer size:", buf.length);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    
    const slideFiles = Object.keys(zip.files)
      .filter((p) => p.startsWith("ppt/slides/slide") && p.endsWith(".xml"))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] || "0");
        const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] || "0");
        return numA - numB;
      });
    
    console.log("[PPTX] Found slides:", slideFiles.length);
    if (slideFiles.length === 0) {
      console.error("[PPTX] No slides found in file");
      return "";
    }
    
    const chunks: string[] = [];
    for (const p of slideFiles) {
      const xml = await zip.files[p].async("string");
      // Extract text specifically from PowerPoint text tags
      const slideText = (xml.match(/<a:t>([^<]*)<\/a:t>/g) || [])
        .map(match => match.replace(/<a:t>|<\/a:t>/g, ""))
        .filter(text => text.trim().length > 0)
        .join(" ");
      if (slideText.trim()) {
        chunks.push(`[Slide ${chunks.length + 1}] ${cleanText(slideText)}`);
      }
    }
    
    const text = cleanText(chunks.join(" "));
    console.log("[PPTX] Extracted text length:", text.length);
    console.log("[PPTX] Sample of extracted text:", text.slice(0, 200));
    
    if (text.length < 50) {
      console.warn("[PPTX] Extracted text is suspiciously short:", text);
      return "";
    }
    
    return text;
  } catch (error) {
    console.error("[PPTX] Error extracting text:", error);
    if (error instanceof Error) {
      console.error("[PPTX] Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
    return ""; }
}

// ---- transcribe an audio File (from client MP3) ----
async function transcribeAudioFile(file: File): Promise<string> {
  const buf = Buffer.from(await file.arrayBuffer());
  return transcribeBuffer(buf, file.name || "audio.mp3", file.type || "application/octet-stream");
}

async function transcribeBuffer(buf: Buffer, filename: string, contentType: string): Promise<string> {
  // Prefer RunPod ASR (Whisper replacement) if configured.
  const hasRunpodAsr = !!(process.env.RUNPOD_ASR_ENDPOINT || process.env.RUNPOD_ASR_ENDPOINT_ID);
  if (hasRunpodAsr) {
    const hasBlobToken = !!process.env.BLOB_READ_WRITE_TOKEN;
    if (!hasBlobToken) {
      throw new Error(
        "Vercel Blob is not configured for server-side uploads. Set BLOB_READ_WRITE_TOKEN in production so the server can upload audio for ASR."
      );
    }
    const safeName = (filename || "audio.mp3").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const pathname = `uploads/audio/${Date.now()}-${safeName}`;
    let blob: { url: string };
    try {
      blob = await put(pathname, new Blob([buf as any]), {
        access: "public",
        contentType: contentType || "application/octet-stream",
        addRandomSuffix: true,
      });
    } catch (e: any) {
      const msg = String(e?.message || e || "BLOB_UPLOAD_FAILED");
      throw new Error(`Vercel Blob upload failed: ${msg}`);
    }

    const asr = await transcribeAudioUrlWithRunpod(blob.url);
    if (!asr.ok) {
      throw new Error(`RunPod ASR failed: ${asr.message} [${asr.code}]`);
    }
    const t = cleanText(asr.transcript || "");
    if (!t) throw new Error("No speech recognized.");
    return t;
  }

  // No OpenAI Whisper fallback: we run RunPod ASR only.
  throw new Error(
    "RunPod ASR is not configured. Set RUNPOD_ASR_ENDPOINT(_ID) and RUNPOD_ASR_API_KEY (or RUNPOD_ASR_API_KEY/RUNPOD_API_KEY) in Vercel env vars."
  );
}

// -------------------- cards --------------------
function buildFlashcardPrompt(text: string, count: number) {
  const n = Math.min(Math.max(count, MIN_CARD_COUNT), 50);
  return `Generate EXACTLY ${n} flashcards from the material.

ABSOLUTE OUTPUT FORMAT (must be valid JSON):
- Output MUST be a JSON array and NOTHING else.
- The first non-whitespace character MUST be '[' and the last MUST be ']'.
- No preface, no explanation, no markdown, no code fences.

JSON schema:
[
  {"q":"...","a":"..."}
]

Rules:
- One concept per card
- Questions are specific and testable
- Answers are concise (1–2 sentences, max ${MAX_A_CHARS} characters)

Material:
${text}`;
}

function buildFlashcardPromptGuided(text: string, count: number) {
  const n = Math.min(Math.max(count, 5), 50);
  return `Generate EXACTLY ${n} flashcards from the material.

ABSOLUTE OUTPUT FORMAT (must be valid JSON matching the schema):
- Output MUST be a JSON object with a top-level key "cards".
- "cards" MUST be a JSON array with EXACTLY ${n} items.
- No preface, no explanation, no markdown, no code fences.

Object shape:
{
  "cards": [
    {"q":"...","a":"..."}
  ]
}

Rules:
- One concept per card
- Questions are specific and testable
- Answers are concise (1–2 sentences, max ${MAX_A_CHARS} characters)

Material:
${text}`;
}

function buildFlashcardPromptQA(text: string, count: number) {
  const n = Math.min(Math.max(count, 5), 50);
  return `Generate EXACTLY ${n} flashcards from the material.

ABSOLUTE OUTPUT FORMAT (NO JSON):
- Output ONLY flashcards in this repeated block format.
- No preface, no explanation, no markdown, no code fences, no numbering.
- The FIRST characters of your response MUST be 'Q:' (no leading whitespace).

Format (repeat EXACTLY ${n} times):
Q: <question>
A: <answer>
---

After the final '---', output the single token:</final>

Example (format only):
Q: What is the main topic?
A: It is about the key ideas in the provided material.
---
Q: What is one important detail?
A: It describes a specific concept mentioned in the material.
---
</final>

Now generate the REAL ${n} flashcards (no placeholders).

Rules:
- One concept per card
- Questions are specific and testable
- Answers are concise (1–2 sentences, max ${MAX_A_CHARS} characters)

Material:
${text}`;
}
async function generateCardsWithOpenAI(
  source: string,
  count = DEFAULT_CARD_COUNT,
  opts?: { preferQa?: boolean }
) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[Cards] OPENAI_API_KEY not configured, using fallback");
    return null;
  }
  
  const llmSource = shrinkSourceForLLM(source, MAX_LLM_SOURCE_CHARS);
  console.log("[Cards] Generating cards from source text length:", source.length);
  console.log("[Cards] LLM input text length:", llmSource.length);
  console.log("[Cards] First 200 chars of LLM input:", llmSource.slice(0, 200));
  console.log("[Cards] Requesting", count, "cards with max_tokens:", OPENAI_MAX_OUTPUT_TOKENS);
  
  const messages = [
    {
      role: "system" as const,
      content:
        `You generate flashcards. You MUST output ONLY valid JSON. Do not include any analysis, reasoning, markdown, or extra text. Each item must have non-empty q and a. q must end with '?'. q must be <= ${MAX_Q_CHARS} characters. a must directly answer q in 1–2 concise sentences and must be <= ${MAX_A_CHARS} characters. If you cannot comply, output [].`
    },
    { role: "user" as const, content: buildFlashcardPrompt(llmSource, count) },
  ];

  // Guided JSON (via OpenAI-compat `response_format: json_schema`) is the most reliable way
  // to force structured output from this endpoint. Default ON; allow opt-out.
  const useGuidedJson = process.env.FLASHCARDS_USE_GUIDED_JSON !== "0";
  console.log(
    `[Cards] Guided JSON mode=${useGuidedJson ? "on" : "off"} (FLASHCARDS_USE_GUIDED_JSON=${process.env.FLASHCARDS_USE_GUIDED_JSON ?? "(default)"})`
  );
  const makeGuidedJson = (n: number) =>
    useGuidedJson
      ? {
          // Note: some OpenAI-compatible servers are flaky with top-level array schemas.
          // Wrapping in an object (cards: [...]) is more consistently honored.
          type: "object",
          additionalProperties: false,
          required: ["cards"],
          properties: {
            cards: {
              type: "array",
              // Requiring *exactly* n items can push the model to generate more output
              // than the deployment's max output tokens, leading to truncated/invalid JSON.
              // We'll accept fewer items and loop to fill the remainder.
              minItems: Math.min(3, n),
              maxItems: n,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["q", "a"],
                properties: {
                  q: { type: "string", minLength: 8, maxLength: Math.max(40, MAX_Q_CHARS) },
                  a: { type: "string", minLength: 12, maxLength: Math.max(80, MAX_A_CHARS) },
                },
              },
            },
          },
        }
      : undefined;

  const modelName = process.env.OPENAI_MODEL || "gpt-4o-mini";
  // For transcripts (esp. YouTube), JSON output often breaks due to unescaped quotes.
  // Q/A mode tends to be faster and more parseable for transcript-like sources.
  // Allow disabling globally via FLASHCARDS_QA_MODE=0, but still allow a caller hint.
  const enableQaMode = process.env.FLASHCARDS_QA_MODE !== "0";
  // IMPORTANT: do not automatically choose Q/A mode based on model name.
  // Some reasoning-style models frequently output preface/prose in Q/A mode, which causes hard failures.
  // Use Q/A only when explicitly requested by the caller.
  const preferQaForModel = enableQaMode && opts?.preferQa === true;
  const n = Math.min(Math.max(count, 5), 50);

  function ensureQuestionMark(q: string) {
    const qq = cleanText(q || "");
    if (!qq) return "";
    return qq.endsWith("?") ? qq : `${qq}?`;
  }

  async function parseCardsFromJsonLike(text: string) {
    let jsonText = text;
    try {
      JSON.parse(jsonText);
    } catch {
      const repaired = repairJsonNewlinesInStrings(jsonText);
      try {
        JSON.parse(repaired);
        jsonText = repaired;
      } catch {
        const extractedObj = extractFirstJsonObject(repaired);
        if (extractedObj) {
          jsonText = extractedObj;
        } else {
          const extractedArr = extractFirstJsonArray(repaired) || extractFirstJsonArrayPrefix(repaired);
          if (extractedArr) jsonText = extractedArr;
        }
      }
    }

    let arr: Array<{
      q?: string;
      a?: string;
      question?: string;
      answer?: string;
    }>;
    try {
      const parsed = JSON.parse(jsonText) as any;
      if (Array.isArray(parsed)) {
        arr = parsed;
      } else if (parsed && typeof parsed === "object") {
        // Some models wrap results: { cards: [...] } or { flashcards: [...] }
        const candidate =
          (Array.isArray(parsed.cards) && parsed.cards) ||
          (Array.isArray(parsed.flashcards) && parsed.flashcards) ||
          (Array.isArray(parsed.items) && parsed.items) ||
          (Array.isArray(parsed.data) && parsed.data);
        if (candidate) arr = candidate;
        else return null;
      } else {
        return null;
      }
    } catch {
      return null;
    }

    const mapped = arr
      .map((c) => ({
        question: typeof c?.q === "string" ? c.q : typeof c?.question === "string" ? c.question : "",
        answer: typeof c?.a === "string" ? c.a : typeof c?.answer === "string" ? c.answer : "",
      }))
      .map((c) => ({ question: ensureQuestionMark(c.question), answer: cleanText(c.answer) }))
      .filter((c) => c.question.length >= 8 && c.answer.length >= 12)
      .map((c) => ({ question: c.question.slice(0, MAX_Q_CHARS), answer: c.answer.slice(0, MAX_A_CHARS) }));

    return mapped.length ? mapped : null;
  }

  async function parseCardsFromAny(text: string) {
    const cleaned = stripFence(String(text || ""));
    const qa = parseCardsFromQA(cleaned);
    if (qa && qa.length) return qa;
    return await parseCardsFromJsonLike(cleaned);
  }

  function parseCardsFromQA(text: string) {
    const normalized = String(text || "").replace(/\r\n/g, "\n");
    const out: Array<{ question: string; answer: string }> = [];

    const normalizeLine = (line: string) => {
      let s = String(line || "").trim();
      // Strip common markdown/bullet prefixes.
      s = s.replace(/^[-*>\u2022]+\s+/, "");
      // Allow bold/underlined labels like **Q:** or __A:__
      s = s.replace(/^\*\*(Q|Question|A|Answer)\*\*\s*([:\-])/i, "$1$2");
      s = s.replace(/^__(Q|Question|A|Answer)__\s*([:\-])/i, "$1$2");
      return s.trim();
    };

    const lines = normalized
      .split("\n")
      .map(normalizeLine)
      .filter((l) => l.length > 0 && l !== "</final>");

    const isSep = (l: string) => l === "---" || l === "***";
    const isQ = (l: string) => /^(?:\d+\s*[).\-]\s*)?(?:Q|Question)\s*[:\-]/i.test(l);
    const isA = (l: string) => /^(?:\d+\s*[).\-]\s*)?(?:A|Answer)\s*[:\-]/i.test(l);
    const stripLabel = (l: string) => l.replace(/^(?:\d+\s*[).\-]\s*)?(?:Q|Question|A|Answer)\s*[:\-]\s*/i, "");

    let currentQ = "";
    let currentA = "";
    let mode: "none" | "q" | "a" = "none";

    const flush = () => {
      const q = cleanText(currentQ);
      const a = cleanText(currentA);
      if (q && a) out.push({ question: q.slice(0, MAX_Q_CHARS), answer: a.slice(0, MAX_A_CHARS) });
      currentQ = "";
      currentA = "";
      mode = "none";
    };

    for (const line of lines) {
      if (out.length >= n) break;
      if (isSep(line)) {
        flush();
        continue;
      }

      // Handle same-line Q and A: "Q: ... A: ..."
      if (isQ(line) && /\b(?:A|Answer)\s*[:\-]/i.test(line)) {
        const parts = line.split(/\b(?:A|Answer)\s*[:\-]\s*/i);
        const qPart = stripLabel(parts[0] || "");
        const aPart = parts.slice(1).join(" ");
        currentQ = qPart;
        currentA = aPart;
        flush();
        continue;
      }

      if (isQ(line)) {
        if (currentQ || currentA) flush();
        mode = "q";
        currentQ += (currentQ ? " " : "") + stripLabel(line);
        continue;
      }

      if (isA(line)) {
        mode = "a";
        currentA += (currentA ? " " : "") + stripLabel(line);
        continue;
      }

      if (mode === "q") currentQ += (currentQ ? " " : "") + line;
      else if (mode === "a") currentA += (currentA ? " " : "") + line;
    }

    if (out.length < n) flush();
    return out.length ? out : null;
  }

  async function runQaPass(remaining: number, already: Array<{ question: string; answer: string }>) {
    const prefix = already.length
      ? `\n\nAlready generated (do NOT repeat):\n${already
          .slice(0, 10)
          .map((c, i) => `- ${i + 1}. ${c.question}`)
          .join("\n")}`
      : "";

    const qaMessages = [
      {
        role: "system" as const,
        content:
          "You are a flashcard generator. Output ONLY flashcards in the requested Q/A format. No analysis, no reasoning, no extra text. If you output anything other than Q/A blocks, it will be rejected.",
      },
      { role: "user" as const, content: `${buildFlashcardPromptQA(llmSource, remaining)}${prefix}` },
      // Assistant prefill to bias the model to start with the required token.
      { role: "assistant" as const, content: "Q:" },
    ];

    // Keep tokens proportional to requested cards to reduce latency.
    const TOKENS_PER_CARD_QA = 80;
    const TOKENS_OVERHEAD_QA = 200;
    const qaMaxTokens = Math.max(
      400,
      Math.min(OPENAI_MAX_OUTPUT_TOKENS, TOKENS_PER_CARD_QA * Math.max(1, remaining) + TOKENS_OVERHEAD_QA)
    );

    const qaResult = await callLLMResult(qaMessages, qaMaxTokens, 0, {
      topP: 1,
      stop: ["</final>"],
      disableOpenAICompat: true,
      timeoutMs: Number(process.env.FLASHCARDS_PRIMARY_TIMEOUT_MS || 295_000),
    });

    return qaResult;
  }

  // Fast path: for DeepSeek-R1, prefer Q/A blocks first (fast + easy to parse).
  // If parsing fails, fall back to guided JSON / strict JSON.
  if (preferQaForModel) {
    console.log(`[Cards] Using Q/A primary mode for model=${modelName}`);

    // If OPENAI_MAX_OUTPUT_TOKENS is low (commonly 800), asking for 10 cards in one Q/A call
    // often truncates mid-output and yields 0–2 parseable cards. Batch Q/A to reliably reach 10.
    const TOKENS_PER_CARD_QA = 80;
    const TOKENS_OVERHEAD_QA = 200;
    const maxCardsByQaTokenCap = Math.max(
      1,
      Math.floor(Math.max(300, OPENAI_MAX_OUTPUT_TOKENS - TOKENS_OVERHEAD_QA) / TOKENS_PER_CARD_QA)
    );

    const cards: Array<{ question: string; answer: string }> = [];
    let qaNoProgress = 0;

    while (cards.length < n) {
      const remaining = n - cards.length;
      const m = Math.max(1, Math.min(remaining, maxCardsByQaTokenCap));
      const qa = await runQaPass(m, cards);
      if (!qa.ok) {
        if (qa.reason === "TIMEOUT" && String(qa.lastStatus || "").toUpperCase() === "IN_QUEUE") {
          const err: any = new Error("RunPod job is still in queue (no capacity). Try again in a minute.");
          err.code = "RUNPOD_IN_QUEUE";
          err.jobId = qa.jobId;
          err.lastStatus = qa.lastStatus;
          throw err;
        }
        console.warn("[Cards] Q/A primary call failed; falling back to JSON attempts");
        break;
      }

      const parsed = qa.content ? await parseCardsFromAny(qa.content) : null;
      const parsedCards = parsed ? [...parsed] : [];
      console.log(`[Cards] Q/A batch returned ${qa.content?.length || 0} chars, parsed ${parsedCards.length}/${m}`);

      const unique = new Map<string, { question: string; answer: string }>();
      for (const c of cards) unique.set(c.question.toLowerCase(), c);
      let added = 0;
      for (const c of parsedCards) {
        const key = c.question.toLowerCase();
        if (unique.has(key)) continue;
        unique.set(key, c);
        added++;
        if (unique.size >= n) break;
      }
      cards.splice(0, cards.length, ...Array.from(unique.values()));

      if (added === 0) {
        qaNoProgress++;
        if (qaNoProgress >= 2) {
          console.warn("[Cards] Q/A batching produced no new cards; falling back to JSON attempts");
          break;
        }
      } else {
        qaNoProgress = 0;
      }
    }

    if (cards.length >= Math.min(n, 10)) {
      return cards.slice(0, n);
    }

    // Otherwise, continue into JSON-guided fallback paths.
  }

  // Guided JSON path: generate in batches and enforce timeouts to avoid platform runtime timeouts.
  if (useGuidedJson) {
    const startedAt = Date.now();
    const envBudgetMs = Number(process.env.FLASHCARDS_WALLCLOCK_BUDGET_MS || "");
    const wallClockBudgetMs =
      Number.isFinite(envBudgetMs) && envBudgetMs > 0
        ? Math.floor(envBudgetMs)
        // Default under maxDuration=300, but high enough to tolerate queueing.
        : 295_000;

    const TOKENS_PER_CARD = 100;
    const TOKENS_OVERHEAD = 300;
    const maxCardsByTokenCap = Math.max(3, Math.floor((OPENAI_MAX_OUTPUT_TOKENS - TOKENS_OVERHEAD) / TOKENS_PER_CARD));

    // For typical deck sizes, prefer a single structured call *when the output token cap allows it*.
    // If OPENAI_MAX_OUTPUT_TOKENS is low (e.g. 800), requesting 20 cards in one go will truncate and break JSON.
    // For larger decks (>25), fall back to batching.
    const envBatchSizeRaw = process.env.FLASHCARDS_BATCH_SIZE;
    const configuredBatchSize = Number(envBatchSizeRaw || "");
    const configuredOrDefault = Math.max(
      3,
      Math.min(25, Number.isFinite(configuredBatchSize) && configuredBatchSize > 0 ? configuredBatchSize : 25)
    );
    const preferredBatchSize = n <= 25 ? n : configuredOrDefault;
    const batchSize = Math.min(preferredBatchSize, maxCardsByTokenCap);
    const baseBatchSize = batchSize;
    let currentBatchSize = batchSize;
    const cards: Array<{ question: string; answer: string }> = [];
    let noProgressStreak = 0;
    const minReturnCount = Math.min(n, MIN_CARD_COUNT);

    // Transcript-like sources can cause the model to repeat itself when prompted with the same
    // material. Rotate excerpts to encourage novelty (helps YouTube transcripts).
    const splitIntoSegments = (text: string, segments: number) => {
      const t = String(text || "");
      if (segments <= 1 || t.length < 400) return [t];
      const out: string[] = [];
      const step = Math.max(1, Math.floor(t.length / segments));
      for (let i = 0; i < segments; i++) {
        const start = i * step;
        const end = i === segments - 1 ? t.length : Math.min(t.length, (i + 1) * step);
        const seg = t.slice(start, end).trim();
        if (seg) out.push(seg);
      }
      return out.length ? out : [t];
    };
    const llmSegments = splitIntoSegments(llmSource, 3);
    let attempt = 0;

    while (cards.length < n) {
      attempt++;
      if (Date.now() - startedAt > wallClockBudgetMs) {
        const err: any = new Error("AI generation took too long. Try fewer cards or retry.");
        err.code = "RUNPOD_TIMEOUT";
        throw err;
      }

      const remaining = n - cards.length;
      const m = Math.min(currentBatchSize, remaining);

      const remainingBudgetMs = wallClockBudgetMs - (Date.now() - startedAt);
      // Ensure we never start a call that cannot complete before our own budget expires.
      // This avoids Vercel killing the function without a structured error response.
      const envPerCallCapMs = Number(process.env.FLASHCARDS_PER_CALL_TIMEOUT_CAP_MS || "");
      const perCallCapMs =
        Number.isFinite(envPerCallCapMs) && envPerCallCapMs > 0
          ? Math.floor(envPerCallCapMs)
          // Default higher than 50s to tolerate RunPod queueing.
          : 295_000;
      const perCallTimeoutMs = Math.max(8_000, Math.min(perCallCapMs, remainingBudgetMs - 1_500));
      if (perCallTimeoutMs < 8_000) {
        const err: any = new Error("AI generation took too long. Try fewer cards or retry.");
        err.code = "RUNPOD_TIMEOUT";
        throw err;
      }
      const avoid = cards.length
        ? `\n\nAlready generated (do NOT repeat these questions):\n${cards
            .slice(0, 12)
            .map((c, i) => `- ${i + 1}. ${c.question}`)
            .join("\n")}`
        : "";

      const segment = llmSegments.length ? llmSegments[(attempt + noProgressStreak) % llmSegments.length] : llmSource;
      const focusHint =
        llmSegments.length > 1
          ? `\n\nImportant: Use ONLY the following excerpt as the material for this batch (do not rely on earlier context).`
          : "";

      const batchMessages = [
        {
          role: "system" as const,
          content:
            "You generate flashcards. Output ONLY valid JSON that matches the provided schema. No analysis, no reasoning, no markdown, no extra text.",
        },
        {
          role: "user" as const,
          content: `${buildFlashcardPromptGuided(segment, m)}${avoid}${focusHint}`,
        },
      ];

      // Keep tokens proportional to requested cards to reduce latency.
      // In practice, 20 structured cards often need ~1600–2400 output tokens once JSON overhead is included.
      // If this is too low, the model truncates mid-string and we get invalid JSON.
      const maxTokens = Math.min(OPENAI_MAX_OUTPUT_TOKENS, TOKENS_PER_CARD * m + TOKENS_OVERHEAD);

      const result = await callLLMResult(batchMessages as any, maxTokens, 0, {
        topP: 1,
        guidedJson: makeGuidedJson(m),
        // NOTE: do NOT disable OpenAI-compat here.
        // Structured output (`response_format: json_schema`) is the main reason this path is reliable.
        timeoutMs: perCallTimeoutMs,
      });

      if (!result.ok) {
        if (result.reason === "TIMEOUT" && String(result.lastStatus || "").toUpperCase() === "IN_QUEUE") {
          const err: any = new Error("RunPod job is still in queue (no capacity). Try again in a minute.");
          err.code = "RUNPOD_IN_QUEUE";
          err.jobId = result.jobId;
          err.lastStatus = result.lastStatus;
          throw err;
        }
        if (result.reason === "TIMEOUT") {
          const err: any = new Error("AI generation took too long. Try fewer cards or retry.");
          err.code = "RUNPOD_TIMEOUT";
          throw err;
        }

        const err: any = new Error("RunPod request failed.");
        err.code = "RUNPOD_HTTP_ERROR";
        err.reason = result.reason;
        err.httpStatus = result.httpStatus;
        throw err;
      }

      const cleaned = stripFence(result.content || "");
      const parsed = await parseCardsFromJsonLike(cleaned);

      if (!parsed || parsed.length === 0) {
        // If the model ignored JSON guidance, it may have output Q/A blocks or prose.
        // Try parsing the *same* output as Q/A (no extra LLM call), otherwise fall back.
        const parsedQa = parseCardsFromQA(cleaned) || [];
        if (parsedQa.length) {
          console.warn("[Cards] Guided JSON parse failed; recovered cards via Q/A parsing");
          for (const c of parsedQa) cards.push(c);
        } else {
          // Last-resort: request Q/A blocks for this batch and parse those.
          // This costs an extra LLM call but prevents hard failures when the model emits nearly-correct JSON
          // (e.g. raw newlines inside strings) that can't be repaired reliably.
          try {
            const qaFallback = await runQaPass(m, cards);
            if (qaFallback.ok && qaFallback.content) {
              const parsedQaFallback = parseCardsFromQA(qaFallback.content) || [];
              if (parsedQaFallback.length) {
                console.warn("[Cards] Guided JSON parse failed; recovered cards via Q/A fallback call");
                const seen = new Set(cards.map((c) => c.question.toLowerCase()));
                for (const c of parsedQaFallback) {
                  const key = c.question.toLowerCase();
                  if (seen.has(key)) continue;
                  seen.add(key);
                  cards.push(c);
                  if (cards.length >= n) break;
                }
                continue;
              }
            }
          } catch (e) {
            console.warn("[Cards] Q/A fallback call failed:", (e as any)?.message || e);
          }

          // If we still can't recover, try a strict "formatter" pass to convert whatever we got into JSON.
          // Reasoning models often follow formatting instructions better than generation instructions.
          try {
            const repairMessages = [
              {
                role: "system" as const,
                content:
                  "You are a strict JSON formatter. Output ONLY valid JSON. No prose, no markdown, no code fences. The output must be a JSON array of objects with keys q and a.",
              },
              {
                role: "user" as const,
                content:
                  `Convert the following into a JSON array of up to ${m} flashcards with keys q and a. Output JSON only.\n\nCONTENT:\n${cleaned}`,
              },
            ];

            const repaired = await callLLMResult(repairMessages, Math.min(OPENAI_MAX_OUTPUT_TOKENS, 900), 0, {
              topP: 1,
              guidedJson: undefined,
              disableOpenAICompat: true,
              timeoutMs: Number(process.env.FLASHCARDS_REPAIR_TIMEOUT_MS || 90_000),
            });

            if (repaired.ok && repaired.content) {
              const repairedClean = stripFence(repaired.content);
              const repairedParsed = await parseCardsFromJsonLike(repairedClean);
              if (repairedParsed && repairedParsed.length) {
                console.warn("[Cards] Guided JSON parse failed; recovered cards via repair pass", {
                  recovered: repairedParsed.length,
                  jobId: repaired.jobId || null,
                });
                for (const c of repairedParsed) cards.push(c);
                continue;
              }
            }
          } catch (e) {
            console.warn("[Cards] Repair pass failed:", (e as any)?.message || e);
          }

          const preview = String(cleaned || "").slice(0, 220);
          const tail = String(cleaned || "").slice(-220);
          const outputLength = String(cleaned || "").length;
          console.warn("[Cards] Guided JSON parse failed; cannot recover cards", {
            preview,
            tail,
            outputLength,
            jobId: result.jobId || null,
          });

          // If we already have enough cards, return a partial deck rather than hard-failing.
          // This avoids turning a mostly-successful run into a 502.
          if (cards.length >= minReturnCount) {
            console.warn(`[Cards] Returning partial deck due to unrecoverable batch output (${cards.length}/${n})`);
            break;
          }

          const err: any = new Error("RunPod returned an invalid format (expected JSON flashcards)");
          err.code = "RUNPOD_BAD_OUTPUT";
          err.preview = preview;
          err.tail = tail;
          err.outputLength = outputLength;
          err.raw = String(cleaned || "").slice(0, 12_000);
          err.jobId = result.jobId || null;
          throw err;
        }
      } else {
        const seen = new Set(cards.map((c) => c.question.toLowerCase()));
        const newlyAdded: Array<{ question: string; answer: string }> = [];
        for (const c of parsed) {
          const key = c.question.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          newlyAdded.push(c);
        }
        if (newlyAdded.length === 0) {
          noProgressStreak++;
          console.warn(`[Cards] Structured parse produced no new unique cards (streak=${noProgressStreak})`);
          // Try reducing the requested batch size to encourage novelty.
          currentBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
          // If the model is stuck repeating itself, try a Q/A pass to fill the remaining slots.
          // Only allow returning a partial deck if we still meet the minimum card count.
          if (noProgressStreak >= 3) {
            if (cards.length >= minReturnCount) {
              console.warn(`[Cards] Returning partial deck due to repetitive output (${cards.length}/${n})`);
              break;
            }

            try {
              const qaFill = await runQaPass(n - cards.length, cards);
              if (qaFill.ok && qaFill.content) {
                const parsedQa = (await parseCardsFromAny(qaFill.content)) || [];
                if (parsedQa.length) {
                  const seen = new Set(cards.map((c) => c.question.toLowerCase()));
                  let added = 0;
                  for (const c of parsedQa) {
                    const key = c.question.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    cards.push(c);
                    added++;
                    if (cards.length >= n) break;
                  }
                  if (added > 0) {
                    console.warn(`[Cards] Q/A fill recovered ${added} cards (${cards.length}/${n})`);
                    noProgressStreak = 0;
                    currentBatchSize = baseBatchSize;
                  }
                }
              }
            } catch (e) {
              console.warn("[Cards] Q/A fill attempt failed:", (e as any)?.message || e);
            }
          }
          if (noProgressStreak >= 4) {
            const err: any = new Error("AI returned repetitive output and could not finish the requested deck.");
            err.code = "RUNPOD_BAD_OUTPUT";
            err.preview = String(cleaned || "").slice(0, 220);
            err.tail = String(cleaned || "").slice(-220);
            err.outputLength = String(cleaned || "").length;
            err.raw = String(cleaned || "").slice(0, 12_000);
            err.jobId = result.jobId || null;
            throw err;
          }
        } else {
          noProgressStreak = 0;
          currentBatchSize = baseBatchSize;
          for (const c of newlyAdded) cards.push(c);
        }
      }

      console.log(`[Cards] Progress: ${cards.length}/${n} (batchSize=${baseBatchSize}, currentBatchSize=${currentBatchSize}, tokenCap=${OPENAI_MAX_OUTPUT_TOKENS})`);

      const unique = new Map<string, { question: string; answer: string }>();
      for (const c of cards) unique.set(c.question.toLowerCase(), c);
      cards.splice(0, cards.length, ...Array.from(unique.values()));
    }

    return cards.slice(0, n);
  }

  // Non-guided path: single call + parse/repair.
  // Zero temperature to reduce non-JSON chatter.
  const TOKENS_PER_CARD_NON_GUIDED = 100;
  const TOKENS_OVERHEAD_NON_GUIDED = 300;
  const nonGuidedMaxTokens = Math.max(
    600,
    Math.min(OPENAI_MAX_OUTPUT_TOKENS, TOKENS_PER_CARD_NON_GUIDED * Math.max(1, n) + TOKENS_OVERHEAD_NON_GUIDED)
  );

  const result = await callLLMResult(messages, nonGuidedMaxTokens, 0, {
    topP: 1,
    guidedJson: undefined,
    disableOpenAICompat: true,
    timeoutMs: Number(process.env.FLASHCARDS_PRIMARY_TIMEOUT_MS || 295_000),
  });
  if (!result.ok) {
    if (result.reason === "TIMEOUT" && String(result.lastStatus || "").toUpperCase() === "IN_QUEUE") {
      const err: any = new Error("RunPod job is still in queue (no capacity). Try again in a minute.");
      err.code = "RUNPOD_IN_QUEUE";
      err.jobId = result.jobId;
      err.lastStatus = result.lastStatus;
      throw err;
    }
    if (result.reason === "TIMEOUT") {
      const err: any = new Error("AI generation took too long. Try fewer cards or retry.");
      err.code = "RUNPOD_TIMEOUT";
      throw err;
    }
    console.warn("[Cards] Using fallback cards due to API failure");
    return null;
  }

  const content = result.content;
  const primaryJobId = result.jobId;
  
  if (!content) {
    console.warn("[Cards] Using fallback cards due to API failure");
    return null;
  }
  
  let cleanedContent = stripFence(content);
  console.log("[Cards] RunPod returned", cleanedContent.length, "chars of response");

  // First parse attempt
  try {
    const parsed = await parseCardsFromJsonLike(cleanedContent);
    if (parsed) return parsed;
  } catch (e) {
    console.error("[Cards] Failed to parse RunPod JSON response:", (e as any)?.message);
    console.error("[Cards] Invalid response content:", cleanedContent.slice(0, 500));
  }

  // One-shot repair attempt: ask the model to convert its own output into JSON-only.
  let repairJobId: string | null = null;
  try {
    const repairMessages = [
      {
        role: "system" as const,
        content:
          "You are a strict JSON formatter. Output ONLY valid JSON. No prose, no markdown, no code fences. The output must be a JSON array of objects with keys q and a.",
      },
      {
        role: "user" as const,
        content:
          `Convert the following into a JSON array of EXACTLY ${Math.min(Math.max(count, 5), 50)} flashcards with keys q and a. Output JSON only.\n\nCONTENT:\n${cleanedContent}`,
      },
    ];

    const repaired = await callLLMResult(repairMessages, OPENAI_MAX_OUTPUT_TOKENS, 0, {
      topP: 1,
      guidedJson: undefined,
      disableOpenAICompat: true,
    });
    if (repaired.ok && repaired.content) {
      repairJobId = repaired.jobId || null;
      cleanedContent = stripFence(repaired.content);
      const parsed = await parseCardsFromJsonLike(cleanedContent);
      if (parsed) return parsed;
    }
  } catch (e) {
    console.warn("[Cards] Repair pass failed:", (e as any)?.message || e);
  }

  // Second fallback: request strict Q/A blocks (more reliable than JSON for reasoning models), then parse into cards.
  try {
    const qaMessages = [
      {
        role: "system" as const,
        content:
          "You are a flashcard generator. Output ONLY flashcards in the requested Q/A format. No analysis, no reasoning, no extra text.",
      },
      { role: "user" as const, content: buildFlashcardPromptQA(llmSource, count) },
    ];

    const qaResult = await callLLMResult(qaMessages, OPENAI_MAX_OUTPUT_TOKENS, 0, {
      topP: 1,
      stop: ["</final>"],
      disableOpenAICompat: true,
    });

    if (qaResult.ok && qaResult.content) {
      const parsed = parseCardsFromQA(qaResult.content);
      if (parsed && parsed.length > 0) {
        console.log("[Cards] Parsed", parsed.length, "cards from Q/A fallback format");
        return parsed;
      }
    }
  } catch (e) {
    console.warn("[Cards] Q/A fallback pass failed:", (e as any)?.message || e);
  }

  const err: any = new Error("RunPod returned non-JSON output; cannot parse flashcards.");
  console.warn("[Cards] Returning fallback cards due to bad model output", {
    preview: String(cleanedContent || "").slice(0, 200),
    jobId: primaryJobId || null,
    repairJobId,
  });
  return null;
}
function fallbackCards(text: string) {
  const chunks = cleanText(text).split(/[.!?]\s+/).slice(0, 20);
  if (!chunks.length) return [
    { question: "What is the main idea?", answer: "This deck was generated without enough context." },
    { question: "What is one key term?", answer: "Add more content to generate richer cards." },
  ];
  return chunks.map((c, i) => ({ question: `Key point ${i + 1}`, answer: c }));
}

// -------------------- route --------------------
export async function POST(req: Request) {
  const t0 = Date.now();
  const traceId = req.headers.get("x-quickstud-trace") || (globalThis.crypto as any)?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const timings: Record<string, number> = {};

  const finalizeTimings = () => {
    timings.total_ms = Math.max(0, Date.now() - t0);
    return timings;
  };

  const respondJson = (body: any, init?: { status?: number }) => {
    return NextResponse.json(
      {
        ...body,
        traceId,
        timings: finalizeTimings(),
      },
      init
    );
  };

  const timeIt = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      timings[label] = Math.max(0, Date.now() - s);
    }
  };

  try {
    const testKey = process.env.FLASHCARDS_TEST_KEY;
    const isTestMode = !!testKey && req.headers.get("x-flashcards-test-key") === testKey;

    let userId: string | null = null;
    if (!isTestMode) {
      const authResult = await timeIt("auth_ms", async () => auth());
      userId = authResult.userId;
      if (!userId) return NextResponse.redirect(new URL("/sign-in", req.url));
    }

    const clerkUserId = userId ?? undefined;

    // In production we should not silently fall back if OpenAI isn't configured.
    if (process.env.NODE_ENV === "production") {
      const missingApiKey = !process.env.OPENAI_API_KEY;
      if (missingApiKey) {
        return NextResponse.json(
          {
            error: "OpenAI is not configured on the server. Set OPENAI_API_KEY in Vercel environment variables.",
            code: "OPENAI_NOT_CONFIGURED",
            missing: {
              OPENAI_API_KEY: missingApiKey,
            },
            vercel: {
              VERCEL_ENV: process.env.VERCEL_ENV || null,
              VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF || null,
              VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || null,
            },
          },
          { status: 500 }
        );
      }
    }

    const form = await timeIt("form_data_ms", async () => req.formData());
    
    // Enforce per-user daily deck creation limit (skip in test mode)
    if (!isTestMode) {
      try {
        const rlStart = Date.now();
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const createdToday = await prisma.deck.count({
          where: { user: { clerkUserId: userId! }, createdAt: { gte: startOfDay } },
        });
        timings.rate_limit_ms = Math.max(0, Date.now() - rlStart);
        if (createdToday >= MAX_DECKS_PER_DAY) {
          return respondJson(
            { error: `Daily limit reached. You can create up to ${MAX_DECKS_PER_DAY} decks per day.`, code: "RATE_LIMIT" },
            { status: 429 }
          );
        }
      } catch (e) {
        console.warn("[RateLimit] Failed to check daily limit:", (e as any)?.message || e);
      }
    }

    // Helper function for getting last value from form
    const getLast = (name: string) => {
      const all = form.getAll(name);
      return all.length ? String(all[all.length - 1] ?? "") : "";
    };

    // Get all form inputs at once
    const formTitle = String(form.get("title") || "").trim();
    let source = String(form.get("source") || "").trim();
    const urlStr = String(form.get("url") || "").trim();
    const docUrl = getLast("docUrl").trim();
    const docName = getLast("docName").trim();
  let file = form.get("file") as File | null;
  let video = form.get("video") as File | null;
  let subtitle = form.get("subtitle") as File | null;
  let audioFile = form.get("audio") as File | null;
  const videoUrl = getLast("videoUrl").trim();
  const videoName = getLast("videoName").trim();
  const audioUrl = getLast("audioUrl").trim();

    // Some browsers/frameworks can submit an empty File placeholder.
    // Treat those as not provided so we don't accidentally trigger video/audio paths.
    if (file && file.size === 0) file = null;
    if (video && video.size === 0) video = null;
    if (subtitle && subtitle.size === 0) subtitle = null;
    if (audioFile && audioFile.size === 0) audioFile = null;
    
    // Debug logging
    console.log("[Form] Received inputs:", {
      title: formTitle,
      hasSource: !!source,
      hasUrl: !!urlStr,
      hasFile: !!file,
      hasVideo: !!video,
      hasSubtitle: !!subtitle,
      hasAudio: !!audioFile || !!audioUrl,
      audioUrl: audioUrl ? "[provided]" : undefined,
      videoUrl: videoUrl || undefined,
      videoName: videoName || undefined,
      fileSize: file?.size,
      videoSize: video?.size,
      subtitleSize: subtitle?.size,
      audioFileName: audioFile?.name,
      audioFileSize: audioFile?.size
    });

    // Initialize source tracking
    const sourceOptions = {
      content: false,
      pdf: false,
      pptx: false,
      url: false,
    };

    // Optional: Block audio/video ingestion to avoid transcription costs
    if (DISABLE_AUDIO_UPLOAD && (audioFile || audioUrl || video || getLast("videoUrl").trim())) {
      return NextResponse.json(
        { error: "Audio/video uploads are disabled in this environment.", code: "AUDIO_DISABLED" },
        { status: 400 }
      );
    }

    // Validate title
    if (!formTitle) {
      return NextResponse.json({ error: "Title is required", code: "TITLE_REQUIRED" }, { status: 400 });
    }
    if (formTitle.length < 3) {
      return NextResponse.json({ error: "Title must be at least 3 characters", code: "TITLE_TOO_SHORT" }, { status: 400 });
    }
    if (formTitle.length > 120) {
      return NextResponse.json({ error: "Title must be at most 120 characters", code: "TITLE_TOO_LONG" }, { status: 400 });
    }

    // Validate content
    const hasRemoteVideo = !!videoUrl;
    const hasDocUrl = !!docUrl;
    const hasAudioUrl = !!audioUrl;
    if (!source && !urlStr && !file && !video && !audioFile && !hasAudioUrl && !subtitle && !hasRemoteVideo && !hasDocUrl) {
      return NextResponse.json(
        {
          error: "Please provide content through text, URL, PDF, PPTX, video, or audio",
          code: "NO_CONTENT",
          inputs: {
            hasSource: !!String(form.get("source") || "").trim(),
            hasUrl: !!urlStr,
            hasFile: !!file,
            hasVideo: !!video || !!videoUrl,
            hasSubtitle: !!subtitle,
            hasAudio: !!audioFile || !!audioUrl,
            hasDocUrl: !!docUrl,
          },
          vercel: {
            VERCEL_ENV: process.env.VERCEL_ENV || null,
            VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || null,
          },
        },
        { status: 400 }
      );
    }

    // Origin tracking
    let origin: "text" | "url" | "youtube" | "video" | "pdf" | "pptx" | "unknown" = "unknown";

    // If the user provided raw text directly, mark origin now.
    // Note: `source` is already populated from the form at this point.
    if (source) origin = "text";

    // 0) Video file - prefer RunPod ASR by URL (fast); fallback to local ffmpeg + Whisper only if needed.
    if (!source && (video || videoUrl)) {
      try {
        const isRemote = !!videoUrl && !video;
        const videoSize = video?.size || 0;
        console.log("[Video] Processing", isRemote ? "remote video URL" : "uploaded video file", isRemote ? videoUrl : video!.name, "size:", videoSize);

        // Some deployments/browsers can submit an empty file object; skip it.
        if (!isRemote && video && videoSize === 0) {
          console.warn("[Video] Uploaded video file has size 0; skipping transcription.");
          throw new Error("Empty video upload");
        }
        
        const hasRunpodAsr = !!(process.env.RUNPOD_ASR_ENDPOINT || process.env.RUNPOD_ASR_ENDPOINT_ID);

        // Fast path: if RunPod ASR is configured, send the video URL directly to the ASR worker.
        // This avoids server-side ffmpeg (slow + fragile on Vercel) and avoids moving large bytes through the function.
        if (hasRunpodAsr) {
          let mediaUrl = videoUrl;
          if (!mediaUrl && video) {
            const safeName = (video.name || videoName || "video.mp4").replace(/[^a-zA-Z0-9._-]+/g, "_");
            const pathname = `uploads/video/${Date.now()}-${safeName}`;
            const blob = await put(pathname, video, {
              access: "public",
              contentType: video.type || "application/octet-stream",
              addRandomSuffix: true,
            });
            mediaUrl = blob.url;
          }

          if (!mediaUrl) throw new Error("Missing videoUrl/video file");

          console.log("[Video] Using RunPod ASR via URL (skipping local ffmpeg)");
          const asrTimeoutMs = Number(process.env.RUNPOD_ASR_TIMEOUT_MS || 90_000);
          const asr = await transcribeAudioUrlWithRunpod(mediaUrl, { timeoutMs: asrTimeoutMs });
          if (asr.ok) {
            const text = cleanText(asr.transcript || "");
            if (!text || text.length < 10) {
              throw new Error("Transcription returned no usable text. The video may have no speech.");
            }

            source = truncate(text);
            origin = "video";
            console.log("[Video] Successfully processed video into", source.length, "chars of text (RunPod ASR)");
          } else {
            // Compatibility fallback: some ASR workers cannot ingest video URLs directly.
            // Extract audio locally with ffmpeg, then send audio to RunPod ASR.
            console.warn(
              "[Video] RunPod ASR URL ingest failed; falling back to local ffmpeg audio extraction:",
              asr.code,
              asr.message
            );

            const { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync } = await import("fs");
            const { tmpdir } = await import("os");
            const { join } = await import("path");
            const { spawn } = await import("child_process");

            const tempDir = mkdtempSync(join(tmpdir(), "quickstud-video-"));
            const videoPath = join(tempDir, `input${(video?.name || videoName || "").match(/\.[^.]+$/)?.[0] || ".mp4"}`);
            const audioPath = join(tempDir, "audio.mp3");

            try {
              if (!isRemote && video) {
                const videoBuffer = Buffer.from(await video.arrayBuffer());
                writeFileSync(videoPath, videoBuffer);
                console.log("[Video] Saved to:", videoPath);
              }

              console.log("[Video] Starting audio extraction with ffmpeg (fallback)...");
              await new Promise<void>((resolve, reject) => {
                const bin = "ffmpeg";
                const ffmpeg = spawn(bin, [
                  "-i",
                  isRemote ? videoUrl : videoPath,
                  "-vn",
                  "-ac",
                  "1",
                  "-ar",
                  "16000",
                  "-b:a",
                  "32k",
                  "-y",
                  audioPath,
                ]);

                let stderr = "";
                ffmpeg.stderr.on("data", (data) => {
                  stderr += data.toString();
                });

                ffmpeg.on("close", (code) => {
                  if (code === 0) return resolve();
                  reject(new Error(`FFmpeg failed with code ${code} (binary: ${bin}). ${stderr.slice(-200)}`));
                });

                ffmpeg.on("error", (err) => {
                  reject(new Error(`Could not spawn ffmpeg: ${err.message}`));
                });
              });

              const audioBuffer = readFileSync(audioPath);
              console.log("[Video] Audio extracted:", audioBuffer.length, "bytes. Sending to RunPod ASR...");

              const text = await transcribeBuffer(audioBuffer, "audio.mp3", "audio/mpeg");
              const cleaned = cleanText(text || "");
              if (!cleaned || cleaned.length < 10) {
                throw new Error("Transcription returned no usable text. The video may have no speech.");
              }

              source = truncate(cleaned);
              origin = "video";
              console.log("[Video] Successfully processed video into", source.length, "chars of text (ffmpeg -> RunPod ASR)");
            } finally {
              try {
                if (!isRemote) unlinkSync(videoPath);
                unlinkSync(audioPath);
                rmSync(tempDir, { recursive: true });
              } catch (e) {
                console.warn("[Video] Cleanup warning:", (e as any)?.message);
              }
            }
          }
        } else {
          throw new Error(
            "RunPod ASR is not configured. Upload audio/video only works when RUNPOD_ASR_ENDPOINT(_ID) and RUNPOD_ASR_API_KEY are set."
          );
        }
      } catch (e: any) {
        console.error("[Video] Processing failed:", e?.message || e);
        if (STRICT_VIDEO) return NextResponse.json({ 
          error: `Video processing failed: ${e?.message || e}`, 
          code: "VIDEO_PROCESS" 
        }, { status: 400 });
        console.warn("[Video] Continuing without video transcription");
      }
    }

    // 0b) Audio file (from client-side processing, legacy)
    if (!source && audioFile) {
      try {
        console.log("[Audio] Transcribing audio file:", audioFile.name, "size:", audioFile.size, "bytes");
        const text = await transcribeAudioFile(audioFile);
        console.log("[Audio] Transcription completed:", text.length, "chars");
        console.log("[Audio] Sample:", text.slice(0, 200));
        if (text) { source = truncate(text); origin = "video"; }
      } catch (e: any) {
        console.error("[Audio] Transcription failed:", e?.message || e);
        if (STRICT_VIDEO) return NextResponse.json({ error: e?.message || "Audio transcription failed.", code: "AUDIO_TRANSCRIBE" }, { status: 400 });
        console.warn("[Audio] Continuing without audio transcription");
      }
    }

    // 0c) Audio URL (preferred for CLI / large files): transcribe via RunPod ASR directly.
    if (!source && audioUrl) {
      const hasRunpodAsr = !!(process.env.RUNPOD_ASR_ENDPOINT || process.env.RUNPOD_ASR_ENDPOINT_ID);
      if (!hasRunpodAsr) {
        return NextResponse.json(
          {
            error:
              "RunPod ASR is not configured. Set RUNPOD_ASR_ENDPOINT(_ID) and RUNPOD_ASR_API_KEY in Vercel env vars.",
            code: "RUNPOD_ASR_NOT_CONFIGURED",
          },
          { status: 500 }
        );
      }
      const asr = await transcribeAudioUrlWithRunpod(audioUrl);
      if (!asr.ok) {
        return NextResponse.json(
          {
            error: `RunPod ASR failed: ${asr.message} [${asr.code}]`,
            code: "ASR_FAIL",
            status: asr.status || null,
            raw: asr.raw || null,
          },
          { status: asr.code === "TIMEOUT" ? 504 : 502 }
        );
      }
      const t = cleanText(asr.transcript || "");
      if (t) {
        source = truncate(t);
        origin = "video";
      }
    }

    // 1) Raw text
    if (!source && form.get("source")) { source = truncate(cleanText(String(form.get("source")))); origin = "text"; }

    // 2) URL: YouTube captions → else scrape website text
    if (!source && urlStr) {
      try {
        const yt = parseYouTube(urlStr);
        if (yt.ok) {
          const u = new URL(yt.canonicalUrl);
          // Prefer Supadata for YouTube transcripts (reliable from Vercel).
          if (!hasSupadataConfigured()) {
            // Without Supadata, YouTube on Vercel is typically unreliable.
            if (!YOUTUBE_ALLOW_LEGACY_FALLBACKS) {
              return respondJson(
                {
                  error:
                    "YouTube links require transcripts via Supadata. Set SUPADATA_API_KEY, or upload audio/video (mp3/m4a/mp4) or captions (.srt/.vtt).",
                  code: "SUPADATA_NOT_CONFIGURED",
                  url: u.toString(),
                },
                { status: 500 }
              );
            }
          } else {
            const supa = await timeIt("supadata_ms", async () =>
              fetchSupadataTranscript({ youtubeUrl: yt.canonicalUrl })
            );
            if (supa.ok) {
              // Shape long transcripts into slide-like chunks so the LLM input shrinker samples
              // across the entire video instead of biasing toward the beginning.
              const slidesBudget = Math.max(8, Math.min(28, Math.floor(MAX_LLM_SOURCE_CHARS / 360)));
              source = truncate(
                formatTranscriptAsSlides(supa.transcript, {
                  maxTotalChars: MAX_LLM_SOURCE_CHARS,
                  slides: slidesBudget,
                  maxCharsPerSlide: 320,
                })
              );
              origin = "youtube";
            } else {
              // Default behavior: fail fast. This avoids timing out on Vercel due to legacy YouTube scraping.
              if (!YOUTUBE_ALLOW_LEGACY_FALLBACKS) {
                return respondJson(
                  {
                    error:
                      "Failed to fetch a YouTube transcript. This video may not have captions/transcript available. Please retry, or upload audio/video (mp3/m4a/mp4) or captions (.srt/.vtt).",
                    code: "SUPADATA_FAILED",
                    diag: { provider: "supadata", reason: supa.reason, httpStatus: supa.httpStatus ?? null },
                  },
                  { status: supa.reason === "NOT_CONFIGURED" ? 500 : 502 }
                );
              }
            }
          }

          // If YouTube URLs are globally disabled, stop here.
          if (!source && DISABLE_YOUTUBE_URLS) {
            return respondJson(
              {
                error:
                  "YouTube links are disabled on this deployment. Please upload audio/video (mp3/m4a/mp4) or captions (.srt/.vtt).",
                code: "YT_URL_DISABLED",
                url: u.toString(),
              },
              { status: 400 }
            );
          }

          // Legacy fallbacks are only reachable when explicitly enabled.
          if (!source && YOUTUBE_ALLOW_LEGACY_FALLBACKS) {
            const ytDiag: any = {
            videoId: getYouTubeId(u),
            captions: { attempted: false, ok: false, error: null as string | null },
            asrWorker: { attempted: false, ok: false, error: null as string | null, configured: false },
            runpodYoutube: { attempted: false, ok: false, error: null as string | null, notConfigured: false, misconfigured: false, detail: null as any },
            asr: {
              attempted: false,
              ok: false,
              error: null as string | null,
              disabledByEnv: DISABLE_AUDIO_UPLOAD,
              hasRunpodAsr: !!(process.env.RUNPOD_ASR_ENDPOINT || process.env.RUNPOD_ASR_ENDPOINT_ID),
              hasBlobToken: !!process.env.BLOB_READ_WRITE_TOKEN,
            },
            vercel: {
              VERCEL_ENV: process.env.VERCEL_ENV || null,
              VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || null,
            },
            };

          try {
            const yt = await extractFromYouTubeStrict(u);
            source = truncate(yt.text);
            origin = "youtube";
            if (!source) throw new Error("YouTube extraction returned empty text");
          } catch (e: any) {
            // Production note: yt-dlp often isn't available on Vercel.
            // Fallback to ytdl-core caption track fetch (no external binary).
            const id = getYouTubeId(u);
            if (id) {
              ytDiag.captions.attempted = true;
              try {
                const text = await fetchYouTubeTranscriptViaYtdlCore(id);
                if (text) {
                  source = truncate(text);
                  origin = "youtube";
                  ytDiag.captions.ok = true;
                }
              } catch (capErr: any) {
                ytDiag.captions.error = String(capErr?.message || capErr || "CAPTIONS_FAILED");
              }

              // Additional fallback: direct timedtext endpoints (manual or auto captions)
              if (!source) {
                try {
                  const tt = await fetchYouTubeTranscriptViaTimedText(id);
                  if (tt) {
                    source = truncate(tt);
                    origin = "youtube";
                    ytDiag.captions.ok = true;
                  }
                } catch (capErr: any) {
                  ytDiag.captions.error = String(capErr?.message || capErr || "CAPTIONS_FAILED");
                }
              }

              // If captions are unavailable from Vercel, optionally offload YouTube download+ASR to an external worker.
              // This is designed for a stable non-Vercel environment (e.g., RunPod Pod / VPS).
              if (!source) {
                ytDiag.asrWorker.configured = !!(process.env.YT_ASR_WORKER_URL || "").trim();
                if (ytDiag.asrWorker.configured) {
                  ytDiag.asrWorker.attempted = true;
                  const w = await transcribeYoutubeViaAsrWorker(u.toString(), { language: "en" }).catch((err: any) => ({
                    ok: false,
                    reason: "EXCEPTION",
                    message: String(err?.message || err || "YT_ASR_WORKER_FAILED"),
                  }));
                  if ((w as any).ok === true) {
                    source = truncate((w as any).transcript);
                    origin = "youtube";
                    ytDiag.asrWorker.ok = true;
                  } else {
                    ytDiag.asrWorker.error = String((w as any)?.message || (w as any)?.reason || "YT_ASR_WORKER_FAILED");
                  }
                }
              }

              // Optional fallback: offload YouTube download+ASR to RunPod (only if configured).
              // If you don't want a separate RunPod endpoint, leave these env vars unset and we'll skip this.
              if (!source) {
                const hasRunpodYoutubeEndpoint = !!(
                  (process.env.RUNPOD_YOUTUBE_ENDPOINT || "").trim() || (process.env.RUNPOD_YOUTUBE_ENDPOINT_ID || "").trim()
                );
                const hasRunpodYoutubeKey = !!(
                  (process.env.RUNPOD_YOUTUBE_API_KEY || "").trim() || (process.env.RUNPOD_API_KEY || "").trim()
                );

                // Common misconfig: pointing the YouTube worker env var at a Whisper/ASR endpoint.
                // A Whisper endpoint expects an *audio URL*; it cannot transcribe a YouTube watch URL unless it was built to download YouTube itself.
                const ytEndpointId = (process.env.RUNPOD_YOUTUBE_ENDPOINT_ID || "").trim();
                const asrEndpointId = (process.env.RUNPOD_ASR_ENDPOINT_ID || "").trim();
                const ytEndpoint = (process.env.RUNPOD_YOUTUBE_ENDPOINT || "").trim();
                const asrEndpoint = (process.env.RUNPOD_ASR_ENDPOINT || "").trim();
                const looksLikeSameId = !!ytEndpointId && !!asrEndpointId && ytEndpointId === asrEndpointId;
                const looksLikeSameExplicit = !!ytEndpoint && !!asrEndpoint && ytEndpoint.replace(/\/+$/, "") === asrEndpoint.replace(/\/+$/, "");
                if (looksLikeSameId || looksLikeSameExplicit) {
                  ytDiag.runpodYoutube.misconfigured = true;
                }

                if (hasRunpodYoutubeEndpoint && hasRunpodYoutubeKey && !ytDiag.runpodYoutube.misconfigured) {
                  ytDiag.runpodYoutube.attempted = true;
                  const ytJob = await transcribeYoutubeUrlWithRunpod(u.toString()).catch((err: any) => ({
                    ok: false,
                    reason: "EXCEPTION",
                    message: String(err?.message || err || "RUNPOD_YOUTUBE_FAILED"),
                  }));

                  if ((ytJob as any).ok === true) {
                    source = truncate((ytJob as any).transcript);
                    origin = "youtube";
                    ytDiag.runpodYoutube.ok = true;
                  } else {
                    ytDiag.runpodYoutube.detail = ytJob;
                    ytDiag.runpodYoutube.error = String(
                      (ytJob as any)?.message || (ytJob as any)?.reason || "RUNPOD_YOUTUBE_FAILED"
                    );
                  }
                }
              }

              // If captions are unavailable, fall back to audio download + RunPod ASR.
              // This avoids requiring yt-dlp/ffmpeg on Vercel.
              if (!source && !DISABLE_AUDIO_UPLOAD) {
                const hasRunpodAsr = !!(process.env.RUNPOD_ASR_ENDPOINT || process.env.RUNPOD_ASR_ENDPOINT_ID);
                if (hasRunpodAsr) {
                  console.log("[YouTube] Captions unavailable; downloading audio for ASR:", id);
                  // Keep this conservative to avoid blowing serverless memory/time.
                  const maxBytes = Number(process.env.YT_AUDIO_MAX_BYTES || 35_000_000);
                  ytDiag.asr.attempted = true;
                  try {
                    const audio = await downloadYouTubeAudioBufferViaYtdlCore(id, maxBytes);
                    const asrText = await transcribeBuffer(audio.buf, audio.filename, audio.contentType);
                    if (asrText) {
                      source = truncate(asrText);
                      origin = "youtube";
                      ytDiag.asr.ok = true;
                    }
                  } catch (asrErr: any) {
                    ytDiag.asr.error = String(asrErr?.message || asrErr || "ASR_FAILED");
                  }
                }
              }
            }

            // If we still don't have text for a YouTube URL, return an actionable error.
            if (!source) {
              if (ytDiag.asr.disabledByEnv) {
                return NextResponse.json(
                  {
                    error: "YouTube captions were unavailable and audio transcription is disabled (DISABLE_AUDIO_UPLOAD=1).",
                    code: "YT_AUDIO_DISABLED",
                    diag: ytDiag,
                  },
                  { status: 400 }
                );
              }
              if (!ytDiag.asr.hasRunpodAsr) {
                return NextResponse.json(
                  {
                    error:
                      "YouTube captions were unavailable and RunPod ASR is not configured in production. Set RUNPOD_ASR_ENDPOINT(_ID) and RUNPOD_ASR_API_KEY in Vercel env vars.",
                    code: "RUNPOD_ASR_NOT_CONFIGURED",
                    diag: ytDiag,
                  },
                  { status: 500 }
                );
              }
              if (ytDiag.asr.attempted && ytDiag.asr.error) {
                const errMsg = String(ytDiag.asr.error || "");
                const looksLikeYouTubeBlocked = /status code:\s*\d+/i.test(errMsg) || /410|403|429/.test(errMsg);
                if (looksLikeYouTubeBlocked) {
                  // If the audio download was blocked AND an external ingest worker was attempted but failed,
                  // return a more actionable error than generic "blocked".
                  if (ytDiag.asrWorker?.attempted && ytDiag.asrWorker?.error) {
                    return NextResponse.json(
                      {
                        error:
                          "YouTube blocked server-side audio download from this deployment, and the external YouTube ASR worker also failed. Check the worker logs and configuration.",
                        code: "YT_ASR_WORKER_FAILED",
                        traceId,
                        diag: ytDiag,
                      },
                      { status: 502 }
                    );
                  }
                  // If the audio download was blocked AND the RunPod YouTube worker was attempted but failed,
                  // return a more actionable error than "blocked".
                  if (ytDiag.runpodYoutube.attempted && ytDiag.runpodYoutube.error) {
                    return NextResponse.json(
                      {
                        error:
                          "YouTube blocked server-side audio download from this deployment, and the RunPod YouTube worker also failed. Check the RunPod worker logs and configuration.",
                        code: "RUNPOD_YOUTUBE_FAILED",
                        traceId,
                        diag: ytDiag,
                      },
                      { status: 502 }
                    );
                  }

                  if (ytDiag.runpodYoutube.misconfigured) {
                    return NextResponse.json(
                      {
                        error:
                          "RUNPOD_YOUTUBE_ENDPOINT(_ID) appears to be pointing at your Whisper/ASR endpoint. A Whisper endpoint expects an audio URL, not a YouTube watch URL. Set RUNPOD_ASR_ENDPOINT(_ID) to your Whisper endpoint, and configure a separate YouTube ingest worker via RUNPOD_YOUTUBE_ENDPOINT_ID (or YT_ASR_WORKER_URL).",
                        code: "RUNPOD_YOUTUBE_MISCONFIGURED",
                        traceId,
                        diag: ytDiag,
                      },
                      { status: 500 }
                    );
                  }
                  return NextResponse.json(
                    {
                      error:
                        "YouTube blocked server-side audio download from this deployment. Use Subtitle upload (.srt/.vtt) or upload audio/video (mp3/m4a). For a reliable paste-a-link fallback when captions aren\u2019t accessible from Vercel, configure YT_ASR_WORKER_URL (external worker) or RUNPOD_YOUTUBE_ENDPOINT_ID (RunPod worker).",
                      code: "YT_AUDIO_DOWNLOAD_FAILED",
                      traceId,
                      diag: ytDiag,
                    },
                    { status: 400 }
                  );
                }
                return NextResponse.json(
                  {
                    error: "YouTube captions were unavailable and audio transcription failed.",
                    code: "YT_ASR_FAILED",
                    diag: ytDiag,
                  },
                  { status: 400 }
                );
              }
            }

            if (!source && STRICT_VIDEO) {
              return NextResponse.json(
                { error: e?.message || "Failed to read YouTube captions.", code: "YT_NO_CAPTIONS" },
                { status: 400 }
              );
            }
          }
          }
        } else {
          // Non-YouTube URL
          const u = new URL(urlStr.includes("://") ? urlStr : `https://${urlStr}`);
          const web = await extractFromWebsite(u);
          if (web?.text) { source = truncate(web.text); origin = "url"; }
        }
      } catch { /* malformed URL */ }
    }

    // 2b) subtitle upload (SRT/VTT) → parse into text
    if (!source && subtitle) {
      try {
        const buf = Buffer.from(await subtitle.arrayBuffer());
        const text = parseSubtitleBuffer(buf);
        if (text) { source = truncate(text); origin = "video"; }
      } catch (e) {
        console.warn("[Subtitle] Failed to parse uploaded subtitle:", (e as any)?.message || e);
      }
    }

    // 3) file → pdf/pptx
    if (!source && file) {
      console.log("[Upload] File received:", { name: file.name, type: file.type, size: file.size });
      const buf = Buffer.from(await file.arrayBuffer());
      const kind = guessKindFromNameType(file.name, file.type);
      console.log("[Upload] Detected file kind:", kind);
      if (kind === "pdf") {
        const text = await extractPdfTextFromBuffer(buf); 
        if (text) { 
          console.log("[Upload] PDF text extracted successfully");
          source = truncate(text);
          origin = "pdf";
        } else {
          console.log("[Upload] PDF text extraction failed - empty result");
        }
      } else if (kind === "pptx") {
        const text = await extractPptxTextFromBuffer(buf);
        if (text) {
          console.log("[Upload] PPTX text extracted successfully");
          source = truncate(text);
          origin = "pptx";
        } else {
          console.log("[Upload] PPTX text extraction failed - empty result");
        }
      }
    }

    // 4) docUrl → pdf/pptx
    if (!source && docUrl) {
      try {
        const head = await fetch(docUrl, { method: "HEAD" }).catch(() => null);
        const ct = head?.ok ? head.headers.get("content-type") || undefined : undefined;
        const res = await fetch(docUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const kind = guessKindFromNameType(docName, ct);
          if (kind === "pdf") {
            const text = await extractPdfTextFromBuffer(buf); if (text) { source = truncate(text); origin = "pdf"; }
          } else if (kind === "pptx") {
            const text = await extractPptxTextFromBuffer(buf); if (text) { source = truncate(text); origin = "pptx"; }
          }
        }
      } catch {}
    }

    // If the user provided an input but we couldn't extract any text, fail loudly.
    // Generating a "generic" deck here leads to low-quality, repetitive cards.
    const providedNonTitleInput =
      !!String(form.get("source") || "").trim() ||
      !!urlStr ||
      !!file ||
      !!video ||
      !!audioFile ||
      !!subtitle ||
      !!videoUrl ||
      !!docUrl ||
      !!audioUrl;

    let title = formTitle;
    if (!source && providedNonTitleInput) {
      return NextResponse.json(
        {
          error:
            "We couldn't extract readable text from what you provided. Try pasting text directly, using a text-based PDF (not scanned images), or providing a different URL/video with captions.",
          code: "NO_TEXT_EXTRACTED",
          inputs: {
            hasSource: !!String(form.get("source") || "").trim(),
            hasUrl: !!urlStr,
            hasFile: !!file,
            hasDocUrl: !!docUrl,
            hasVideo: !!video || !!videoUrl,
            hasSubtitle: !!subtitle,
            hasAudio: !!audioFile || !!audioUrl,
          },
        },
        { status: 400 }
      );
    }
    if (!title) {
      if (docName) title = docName.replace(/\.(pdf|pptx)$/i, "");
      else if (urlStr) {
        try {
          const u = new URL(urlStr);
          title = isYouTubeHostname(u.hostname) ? `YouTube ${getYouTubeId(u) ?? u.hostname}` : u.hostname;
        } catch { title = "New Deck"; }
      } else title = "New Deck";
    }
    title = title.slice(0, 120);

    // Get card count from form data (default to 20)
    const requestedCardCountRaw = Number(form.get("cardCount")) || DEFAULT_CARD_COUNT;
    const cardCount = Math.min(Math.max(requestedCardCountRaw, MIN_CARD_COUNT), 50);
    console.log(`[Cards] Generating ${cardCount} flashcards for deck: ${title}`);

    // Generate cards through the central reasoning engine.
    let flashcardResult: Awaited<ReturnType<typeof reasoningEngine.generateFlashcards>> = null;
    try {
      flashcardResult = await timeIt("llm_flashcards_ms", async () =>
        reasoningEngine.generateFlashcards(
          { source, count: cardCount, title },
          async ({ source: candidateSource, count: candidateCount, attempt }) =>
            generateCardsWithOpenAI(candidateSource, candidateCount, { preferQa: attempt > 1 })
        )
      );
    } catch (e: any) {
      if (e?.code === "AI_NO_FLASHCARDS") {
        return respondJson(
          {
            error:
              "AI did not return parseable flashcards. Please retry. If this persists, the RunPod template/model likely isn't honoring guided JSON.",
            code: "AI_NO_FLASHCARDS",
          },
          { status: 502 }
        );
      }
      if (e?.code === "RUNPOD_IN_QUEUE") {
        return respondJson(
          {
            error: "AI generation is queued on RunPod and did not start within the request time limit. Please retry shortly.",
            code: "RUNPOD_IN_QUEUE",
            jobId: e?.jobId || null,
            lastStatus: e?.lastStatus || null,
          },
          { status: 503 }
        );
      }

      if (e?.code === "RUNPOD_TIMEOUT") {
        return respondJson(
          {
            error:
              "AI generation took too long and timed out. Try fewer cards (e.g. 10) or retry shortly.",
            code: "RUNPOD_TIMEOUT",
          },
          { status: 504 }
        );
      }

      if (e?.code === "RUNPOD_BAD_OUTPUT") {
        return respondJson(
          {
            error:
              "AI returned an invalid format (expected JSON flashcards). Please retry, or adjust the RunPod template/model to output strict JSON.",
            code: "RUNPOD_BAD_OUTPUT",
            preview: e?.preview || null,
            tail: e?.tail || null,
            outputLength: typeof e?.outputLength === "number" ? e.outputLength : null,
            raw: isTestMode ? e?.raw || null : null,
            jobId: e?.jobId || null,
            repairJobId: e?.repairJobId || null,
          },
          { status: 502 }
        );
      }
      throw e;
    }
    const cards = flashcardResult?.cards ?? (() => {
      const allowFallback = process.env.FLASHCARDS_ALLOW_FALLBACK === "1";
      if (process.env.NODE_ENV === "production" && !allowFallback) {
        // Creating a deck with sentence-chunks looks like a successful run but isn't useful.
        // Fail loudly so the user can retry and we can observe the real error mode.
        throw Object.assign(new Error("AI did not return parseable flashcards."), { code: "AI_NO_FLASHCARDS" });
      }
      console.warn("[Cards] ⚠️ USING FALLBACK CARDS - AI generation failed or unavailable");
      return fallbackCards(source).map((c) => ({ question: c.question, answer: c.answer }));
    })();

    // Hard guarantee: never claim success with fewer than the minimum.
    if (cards.length < MIN_CARD_COUNT) {
      return respondJson(
        {
          error: `AI returned only ${cards.length} cards; expected at least ${MIN_CARD_COUNT}. Please retry.`,
          code: "AI_INSUFFICIENT_CARDS",
          cardCountRequested: cardCount,
          cardCountReturned: cards.length,
        },
        { status: 502 }
      );
    }

    // Test mode: don't touch the DB, just return the cards.
    if (isTestMode) {
      const llmSource = shrinkSourceForLLM(source, MAX_LLM_SOURCE_CHARS);
      return respondJson(
        {
          ok: true,
          mode: "test",
          title,
          origin,
          cardCountRequested: cardCount,
          cardCountReturned: cards.length,
          reasoning: flashcardResult?.response ?? null,
          reasoningMetadata: flashcardResult?.metadata ?? null,
          debug: {
            sourceLength: source.length,
            sourcePreview: source.slice(0, 240),
            llmSourceLength: llmSource.length,
            llmSourcePreview: llmSource.slice(0, 240),
          },
          cards,
        },
        { status: 200 }
      );
    }

    // Ensure user
    const userRow = await timeIt("db_user_upsert_ms", async () =>
      prisma.user.upsert({
        where: { clerkUserId }, update: {}, create: { clerkUserId: clerkUserId! },
      })
    );

    // Create deck
    let deckId: string;
    try {
      const deck = await timeIt("db_deck_create_ms", async () =>
        prisma.deck.create({
          data: { title, userId: userRow.id, /* @ts-ignore */ source: truncate(source) },
          select: { id: true },
        })
      );
      deckId = deck.id;
    } catch {
      const deck = await timeIt("db_deck_create_ms", async () =>
        prisma.deck.create({ data: { title, userId: userRow.id }, select: { id: true } })
      );
      deckId = deck.id;
    }

    if (cards.length) {
      await timeIt("db_cards_create_ms", async () =>
        prisma.card.createMany({ data: cards.map((c) => ({ deckId, question: c.question, answer: c.answer })) })
      );
    }

    if (flashcardResult) {
      const studentState = await timeIt("db_student_state_read_ms", async () => getStudentKnowledgeState(userRow.id));
      await timeIt("db_reasoning_run_create_ms", async () =>
        persistFlashcardReasoningRun({
          userId: userRow.id,
          deckId,
          title,
          origin,
          source,
          result: flashcardResult,
          metadata: {
            misconceptionSignals: studentState?.priorMistakes || [],
            weakTopicMatches: studentState?.weakTopics || [],
          },
        })
      );
    }

    const redirectUrl = new URL(`/app/deck/${deckId}`, req.url);
    redirectUrl.searchParams.set("origin", origin);
    return NextResponse.redirect(redirectUrl, { status: 303 });
  } catch (e: any) {
    console.error("[Flashcards] Unhandled error", { traceId, message: e?.message, code: e?.code });
    return respondJson(
      { error: e?.message || "Failed to generate", code: e?.code || "SERVER_FAIL" },
      { status: 500 }
    );
  }
}
