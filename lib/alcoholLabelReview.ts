export const STANDARD_GOVERNMENT_WARNING =
  "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.";

export type ApplicationData = {
  brand_name: string;
  class_type: string;
  abv?: string;
  proof?: string;
  net_contents: string;
  government_warning?: string;
};

export type ExtractedFieldKey =
  | "brand_name"
  | "class_type"
  | "abv"
  | "proof"
  | "net_contents"
  | "government_warning";

export type ExtractedLabelData = {
  raw_text: string;
  fields: Partial<Record<ExtractedFieldKey, string>>;
  image_quality_issues: string[];
  ambiguities: string[];
  field_confidence: Partial<Record<ExtractedFieldKey, number>>;
};

export type LabelReviewCheck = {
  key: ExtractedFieldKey | "government_warning_heading";
  label: string;
  status: "pass" | "fail" | "manual";
  expected: string;
  actual: string;
  confidence: number;
  explanation: string;
};

export type LabelReviewResult = {
  applicationData: ApplicationData;
  extracted: ExtractedLabelData;
  checks: LabelReviewCheck[];
  overallRecommendation: "pass" | "manual_review" | "reject";
  summary: string;
  criticalFindings: string[];
};

export const alcoholLabelExtractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["raw_text", "fields", "image_quality_issues", "ambiguities", "field_confidence"],
  properties: {
    raw_text: { type: "string" },
    fields: {
      type: "object",
      additionalProperties: false,
      properties: {
        brand_name: { type: "string" },
        class_type: { type: "string" },
        abv: { type: "string" },
        proof: { type: "string" },
        net_contents: { type: "string" },
        government_warning: { type: "string" },
      },
    },
    image_quality_issues: { type: "array", items: { type: "string" } },
    ambiguities: { type: "array", items: { type: "string" } },
    field_confidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        brand_name: { type: "number" },
        class_type: { type: "number" },
        abv: { type: "number" },
        proof: { type: "number" },
        net_contents: { type: "number" },
        government_warning: { type: "number" },
      },
    },
  },
} as const;

export function parseApplicationData(raw: string): ApplicationData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Application data must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Application data must be a JSON object for single review.");
  }

  const candidate = parsed as Record<string, unknown>;
  const result: ApplicationData = {
    brand_name: clean(candidate.brand_name),
    class_type: clean(candidate.class_type),
    abv: clean(candidate.abv) || undefined,
    proof: clean(candidate.proof) || undefined,
    net_contents: clean(candidate.net_contents),
    government_warning: clean(candidate.government_warning) || STANDARD_GOVERNMENT_WARNING,
  };

  if (!result.brand_name || !result.class_type || !result.net_contents) {
    throw new Error("Application data must include brand_name, class_type, and net_contents.");
  }

  return result;
}

export function buildHeuristicExtraction(rawText: string): ExtractedLabelData {
  const collapsed = collapseWhitespace(rawText);
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const classLine =
    lines.find((line) => /\b(whiskey|whisky|bourbon|vodka|rum|gin|tequila|wine|beer|lager|ale|liqueur|cider|spirits)\b/i.test(line)) ||
    "";
  const abvMatch = collapsed.match(/\b(\d{1,2}(?:\.\d)?)\s*%\s*(?:alc\.?\/?vol\.?|abv)?\b/i);
  const proofMatch = collapsed.match(/\b(\d{2,3})\s*proof\b/i);
  const netMatch = collapsed.match(/\b(\d+(?:\.\d+)?)\s*(ml|mL|l|L|fl\.?\s*oz\.?)\b/);
  const warningStart = collapsed.search(/government warning:/i);
  const warningText = warningStart >= 0 ? collapsed.slice(warningStart).trim() : "";

  const brandLine = lines.find((line) => {
    if (line === classLine) return false;
    if (/government warning:/i.test(line)) return false;
    if (/\b\d+(?:\.\d+)?\s*(ml|mL|l|L|proof|%|alc)/i.test(line)) return false;
    return line.length >= 5;
  }) || "";

  return {
    raw_text: collapsed,
    fields: {
      brand_name: brandLine || undefined,
      class_type: classLine || undefined,
      abv: abvMatch ? `${abvMatch[1]}%` : undefined,
      proof: proofMatch ? proofMatch[1] : undefined,
      net_contents: netMatch ? `${netMatch[1]} ${netMatch[2]}`.replace(/\s+/g, " ") : undefined,
      government_warning: warningText || undefined,
    },
    image_quality_issues: [],
    ambiguities: [],
    field_confidence: {
      brand_name: brandLine ? 0.52 : 0,
      class_type: classLine ? 0.62 : 0,
      abv: abvMatch ? 0.72 : 0,
      proof: proofMatch ? 0.72 : 0,
      net_contents: netMatch ? 0.74 : 0,
      government_warning: warningText ? 0.66 : 0,
    },
  };
}

export function buildLabelReviewResult(applicationData: ApplicationData, extracted: ExtractedLabelData): LabelReviewResult {
  const checks: LabelReviewCheck[] = [];

  checks.push(compareLooseField("brand_name", "Brand name", applicationData.brand_name, extracted.fields.brand_name, extracted.field_confidence.brand_name));
  checks.push(compareLooseField("class_type", "Class/type", applicationData.class_type, extracted.fields.class_type, extracted.field_confidence.class_type));

  if (applicationData.abv) {
    checks.push(compareAlcoholField("abv", "Alcohol content", applicationData.abv, extracted.fields.abv, extracted.field_confidence.abv));
  }

  if (applicationData.proof) {
    checks.push(compareAlcoholField("proof", "Proof", applicationData.proof, extracted.fields.proof, extracted.field_confidence.proof));
  }

  checks.push(compareNetContents(applicationData.net_contents, extracted.fields.net_contents, extracted.field_confidence.net_contents));
  checks.push(compareGovernmentWarning(applicationData.government_warning || STANDARD_GOVERNMENT_WARNING, extracted));

  const failed = checks.filter((check) => check.status === "fail");
  const manual = checks.filter((check) => check.status === "manual");
  const criticalFindings = [...failed, ...manual]
    .map((check) => `${check.label}: ${check.explanation}`)
    .slice(0, 6);

  let overallRecommendation: LabelReviewResult["overallRecommendation"] = "pass";
  if (failed.length > 0) {
    overallRecommendation = "reject";
  } else if (manual.length > 0 || extracted.ambiguities.length > 0 || extracted.image_quality_issues.length > 0) {
    overallRecommendation = "manual_review";
  }

  return {
    applicationData,
    extracted,
    checks,
    overallRecommendation,
    summary: buildSummary(overallRecommendation, failed.length, manual.length),
    criticalFindings,
  };
}

function buildSummary(status: LabelReviewResult["overallRecommendation"], failedCount: number, manualCount: number) {
  if (status === "pass") return "All required prototype checks passed.";
  if (status === "reject") return `${failedCount} required check${failedCount === 1 ? "" : "s"} failed.`;
  return `${manualCount} item${manualCount === 1 ? " needs" : "s need"} manual review before approval.`;
}

function compareLooseField(
  key: ExtractedFieldKey,
  label: string,
  expected: string,
  actual: string | undefined,
  confidence = 0
): LabelReviewCheck {
  if (!clean(actual)) {
    return createCheck(key, label, "fail", expected, actual, confidence, "Field was not found on the label.");
  }

  if (normalizeLoose(expected) === normalizeLoose(actual)) {
    return createCheck(key, label, "pass", expected, actual, confidence, "Matches after normalizing case and punctuation.");
  }

  if (normalizeLoose(actual).includes(normalizeLoose(expected)) || normalizeLoose(expected).includes(normalizeLoose(actual))) {
    return createCheck(key, label, "manual", expected, actual, confidence, "Looks close, but the extracted value is not an exact normalized match.");
  }

  return createCheck(key, label, "fail", expected, actual, confidence, "Label value does not match the application value.");
}

function compareAlcoholField(
  key: "abv" | "proof",
  label: string,
  expected: string,
  actual: string | undefined,
  confidence = 0
): LabelReviewCheck {
  const expectedNumber = parseNumber(expected);
  const actualNumber = parseNumber(actual);

  if (actualNumber == null) {
    return createCheck(key, label, "fail", expected, actual, confidence, "Alcohol value was not found on the label.");
  }

  if (expectedNumber != null && Math.abs(expectedNumber - actualNumber) < 0.001) {
    return createCheck(key, label, "pass", expected, actual, confidence, "Numeric alcohol value matches.");
  }

  return createCheck(key, label, "fail", expected, actual, confidence, "Numeric alcohol value does not match the application.");
}

function compareNetContents(expected: string, actual: string | undefined, confidence = 0): LabelReviewCheck {
  const expectedValue = parseMeasurement(expected);
  const actualValue = parseMeasurement(actual);

  if (!actualValue) {
    return createCheck("net_contents", "Net contents", "fail", expected, actual, confidence, "Net contents were not found on the label.");
  }

  if (expectedValue && actualValue && expectedValue.unit === actualValue.unit && Math.abs(expectedValue.value - actualValue.value) < 0.001) {
    return createCheck("net_contents", "Net contents", "pass", expected, actual, confidence, "Net contents match.");
  }

  if (normalizeLoose(expected) === normalizeLoose(actual)) {
    return createCheck("net_contents", "Net contents", "pass", expected, actual, confidence, "Net contents match after normalization.");
  }

  return createCheck("net_contents", "Net contents", "fail", expected, actual, confidence, "Net contents do not match the application.");
}

function compareGovernmentWarning(expected: string, extracted: ExtractedLabelData): LabelReviewCheck {
  const actual = clean(extracted.fields.government_warning) || warningSliceFromRawText(extracted.raw_text);
  const confidence = extracted.field_confidence.government_warning ?? 0;
  if (!actual) {
    return createCheck(
      "government_warning",
      "Government warning",
      "fail",
      expected,
      actual,
      confidence,
      "Required warning statement was not detected."
    );
  }

  const expectedNormalized = normalizeWarning(expected);
  const actualNormalized = normalizeWarning(actual);
  const hasUppercaseHeading = /GOVERNMENT WARNING:/.test(actual);
  const hasOnlyNonUppercaseHeading = /government warning:/i.test(actual) && !hasUppercaseHeading;

  if (actualNormalized === expectedNormalized && hasUppercaseHeading) {
    return createCheck(
      "government_warning",
      "Government warning",
      "pass",
      expected,
      actual,
      confidence,
      "Warning text matches the required wording. Bold styling is not verified in this prototype."
    );
  }

  if (actualNormalized === expectedNormalized && hasOnlyNonUppercaseHeading) {
    return createCheck(
      "government_warning_heading",
      "Government warning heading",
      "fail",
      "GOVERNMENT WARNING:",
      actual.match(/government warning:/i)?.[0] || actual,
      confidence,
      "Heading text is present but not uppercase as required."
    );
  }

  if (actualNormalized.includes("government warning") || expectedNormalized.includes(actualNormalized)) {
    return createCheck(
      "government_warning",
      "Government warning",
      "manual",
      expected,
      actual,
      confidence,
      "Warning looks partial or OCR-distorted and needs human review."
    );
  }

  return createCheck(
    "government_warning",
    "Government warning",
    "fail",
    expected,
    actual,
    confidence,
    "Warning wording does not match the required text."
  );
}

function createCheck(
  key: ExtractedFieldKey | "government_warning_heading",
  label: string,
  status: LabelReviewCheck["status"],
  expected: string,
  actual: string | undefined,
  confidence: number,
  explanation: string
): LabelReviewCheck {
  return {
    key,
    label,
    status,
    expected: clean(expected),
    actual: clean(actual),
    confidence: roundConfidence(confidence),
    explanation,
  };
}

function warningSliceFromRawText(rawText: string) {
  const collapsed = collapseWhitespace(rawText);
  const start = collapsed.search(/government warning:/i);
  return start >= 0 ? collapsed.slice(start) : "";
}

function parseMeasurement(value: string | undefined) {
  const match = clean(value).match(/(\d+(?:\.\d+)?)\s*(ml|mL|l|L|fl\.?\s*oz\.?)/);
  if (!match) return null;
  return {
    value: Number(match[1]),
    unit: match[2].toLowerCase().replace(/\s+/g, ""),
  };
}

function parseNumber(value: string | undefined) {
  const match = clean(value).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeLoose(value: string | undefined) {
  return clean(value)
    .toUpperCase()
    .replace(/[’']/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function normalizeWarning(value: string | undefined) {
  return clean(value)
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseWhitespace(value: string | undefined) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clean(value: unknown) {
  return String(value || "").trim();
}

function roundConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}