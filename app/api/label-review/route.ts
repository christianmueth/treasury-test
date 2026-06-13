import { NextResponse } from "next/server";
import { callLLMResult } from "@/lib/aiClient";
import {
  alcoholLabelExtractionSchema,
  buildHeuristicExtraction,
  buildLabelReviewResult,
  parseApplicationData,
  type ExtractedLabelData,
} from "@/lib/alcoholLabelReview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LABEL_FILE_BYTES = 12 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 12_000;

export async function POST(req: Request) {
  const startedAt = Date.now();

  try {
    const formData = await req.formData();
    const label = formData.get("label") as File | null;
    const applicationDataText = String(formData.get("applicationData") || "");

    if (!label) {
      return NextResponse.json({ ok: false, error: "A label file is required." }, { status: 400 });
    }

    if (label.size <= 0 || label.size > MAX_LABEL_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: "Label file must be between 1 byte and 12MB." }, { status: 400 });
    }

    const applicationData = parseApplicationData(applicationDataText);
    const extracted = await extractLabelData(label);
    const review = buildLabelReviewResult(applicationData, extracted);

    return NextResponse.json({
      ok: true,
      review,
      timings: {
        total_ms: Date.now() - startedAt,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Label review failed.",
      },
      { status: 500 }
    );
  }
}

async function extractLabelData(file: File): Promise<ExtractedLabelData> {
  const mimeType = file.type || inferMimeType(file.name);
  const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(file.name);

  if (isPdf) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const rawText = await extractPdfTextFromBuffer(buffer);
    if (!rawText) {
      throw new Error("The PDF could not be read. Try a searchable PDF or a clear PNG/JPG label image.");
    }

    if (!process.env.OPENAI_API_KEY?.trim()) {
      return buildHeuristicExtraction(rawText);
    }

    return extractWithTextModel(rawText);
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Image review requires OPENAI_API_KEY in this prototype. PDFs can still be reviewed locally when text is extractable.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  return extractWithVision(bytes, mimeType);
}

async function extractWithTextModel(rawText: string): Promise<ExtractedLabelData> {
  const result = await Promise.race([
    callLLMResult(
      [
        {
          role: "system",
          content:
            "You extract alcohol label fields for a compliance review prototype. Return JSON only. Preserve raw label wording as written. Keep GOVERNMENT WARNING heading casing exactly as observed.",
        },
        {
          role: "user",
          content: [
            "Extract these fields when present: brand_name, class_type, abv, proof, net_contents, government_warning.",
            "Include the complete raw_text, image_quality_issues, ambiguities, and confidence per field from 0 to 1.",
            "If a field is absent, omit it from fields.",
            "Label text:",
            rawText,
          ].join("\n\n"),
        },
      ],
      1200,
      0,
      {
        guidedJson: alcoholLabelExtractionSchema,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "alcohol_label_extraction",
            schema: alcoholLabelExtractionSchema,
          },
        },
        timeoutMs: MODEL_TIMEOUT_MS,
      }
    ),
    createModelTimeout(),
  ]);

  if (!result.ok) {
    throw new Error(result.message || "Structured extraction failed.");
  }

  return normalizeExtractedPayload(result.content, rawText);
}

async function extractWithVision(bytes: Buffer, mimeType: string): Promise<ExtractedLabelData> {
  const base64 = bytes.toString("base64");
  const result = await Promise.race([
    callLLMResult(
      [
        {
          role: "system",
          content:
            "You extract alcohol label fields for a compliance review prototype. Return JSON only. Preserve raw label wording as written. Keep GOVERNMENT WARNING heading casing exactly as observed.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Extract these fields when present: brand_name, class_type, abv, proof, net_contents, government_warning.",
                "Include the complete raw_text, image_quality_issues, ambiguities, and confidence per field from 0 to 1.",
                "If the image is hard to read, state why in image_quality_issues.",
              ].join("\n"),
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
                detail: "low",
              },
            },
          ],
        } as never,
      ],
      1200,
      0,
      {
        guidedJson: alcoholLabelExtractionSchema,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "alcohol_label_extraction",
            schema: alcoholLabelExtractionSchema,
          },
        },
        timeoutMs: MODEL_TIMEOUT_MS,
      }
    ),
    createModelTimeout(),
  ]);

  if (!result.ok) {
    throw new Error(result.message || "Vision extraction failed.");
  }

  return normalizeExtractedPayload(result.content, "");
}

function normalizeExtractedPayload(content: string, fallbackRawText: string): ExtractedLabelData {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") {
    return buildHeuristicExtraction(fallbackRawText || content);
  }

  const candidate = parsed as Record<string, any>;
  return {
    raw_text: String(candidate.raw_text || fallbackRawText || "").trim(),
    fields: normalizeFields(candidate.fields),
    image_quality_issues: toStringArray(candidate.image_quality_issues),
    ambiguities: toStringArray(candidate.ambiguities),
    field_confidence: normalizeConfidence(candidate.field_confidence),
  };
}

function normalizeFields(value: unknown) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    brand_name: toOptionalString(source.brand_name),
    class_type: toOptionalString(source.class_type),
    abv: toOptionalString(source.abv),
    proof: toOptionalString(source.proof),
    net_contents: toOptionalString(source.net_contents),
    government_warning: toOptionalString(source.government_warning),
  };
}

function normalizeConfidence(value: unknown) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    brand_name: toConfidence(source.brand_name),
    class_type: toConfidence(source.class_type),
    abv: toConfidence(source.abv),
    proof: toConfidence(source.proof),
    net_contents: toConfidence(source.net_contents),
    government_warning: toConfidence(source.government_warning),
  };
}

async function extractPdfTextFromBuffer(buf: Buffer): Promise<string> {
  try {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const data = await pdfParse(buf, { max: 0 });
    return String(data?.text || "").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function createModelTimeout() {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Label extraction timed out before the model responded.")), MODEL_TIMEOUT_MS);
  });
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function toOptionalString(value: unknown) {
  const text = String(value || "").trim();
  return text || undefined;
}

function toConfidence(value: unknown) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
}

function inferMimeType(fileName: string) {
  if (/\.png$/i.test(fileName)) return "image/png";
  if (/\.jpe?g$/i.test(fileName)) return "image/jpeg";
  if (/\.pdf$/i.test(fileName)) return "application/pdf";
  return "application/octet-stream";
}