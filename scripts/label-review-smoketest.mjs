#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const key = token.slice(2);
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "true");
    continue;
  }
  args.set(key, next);
  index += 1;
}

const base = String(args.get("base") || "http://localhost:3000").replace(/\/+$/, "");
const filePath = args.get("file") ? path.resolve(String(args.get("file"))) : "";

const applicationData = {
  brand_name: "OLD TOM DISTILLERY",
  class_type: "Kentucky Straight Bourbon Whiskey",
  abv: "45%",
  proof: "90",
  net_contents: "750 mL",
  government_warning:
    "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems.",
};

const labelLines = [
  "OLD TOM DISTILLERY",
  "Kentucky Straight Bourbon Whiskey",
  "45% Alc./Vol. (90 Proof)",
  "750 mL",
  applicationData.government_warning,
];

async function main() {
  const pageResponse = await fetch(`${base}/label-review`);
  const pageHtml = await pageResponse.text();
  if (!pageResponse.ok) {
    throw new Error(`Expected ${base}/label-review to return 200, received ${pageResponse.status}.`);
  }
  if (!/Alcohol label verification in one review screen/i.test(pageHtml)) {
    throw new Error("Label review page loaded, but expected prototype heading text was not found.");
  }
  if (!/Review label|Review batch/i.test(pageHtml)) {
    throw new Error("Label review page loaded, but the primary review controls were not found.");
  }

  const emptyResponse = await fetch(`${base}/api/label-review`, {
    method: "POST",
    body: new FormData(),
  });
  const emptyPayload = await parseJsonResponse(emptyResponse);
  if (emptyResponse.status !== 400 || emptyPayload?.error !== "A label file is required.") {
    throw new Error(`Expected missing-file validation error from /api/label-review, received ${emptyResponse.status}: ${JSON.stringify(emptyPayload)}`);
  }

  const output = {
    ok: true,
    mode: filePath ? "contract+file" : "contract",
    base,
    page: {
      status: pageResponse.status,
      headingVerified: true,
      controlsVerified: true,
    },
    apiValidation: {
      status: emptyResponse.status,
      error: emptyPayload.error,
    },
  };

  if (!filePath) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append("label", new Blob([buffer], { type: inferMimeType(filePath) }), path.basename(filePath));
  form.append("applicationData", JSON.stringify(applicationData));

  const fullResponse = await fetch(`${base}/api/label-review`, {
    method: "POST",
    body: form,
  });
  const fullPayload = await parseJsonResponse(fullResponse);

  if (!fullResponse.ok || !fullPayload?.ok || !fullPayload?.review) {
    throw new Error(`Full file review failed (${fullResponse.status}): ${JSON.stringify(fullPayload)}`);
  }

  output.fullReview = {
    file: filePath,
    status: fullResponse.status,
    overallRecommendation: fullPayload.review.overallRecommendation,
    summary: fullPayload.review.summary,
  };

  console.log(JSON.stringify(output, null, 2));
}

async function parseJsonResponse(response) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(`Expected JSON response but received: ${rawText.slice(0, 400)}`);
  }
}

function inferMimeType(filePathValue) {
  if (/\.pdf$/i.test(filePathValue)) return "application/pdf";
  if (/\.png$/i.test(filePathValue)) return "image/png";
  if (/\.jpe?g$/i.test(filePathValue)) return "image/jpeg";
  return "application/octet-stream";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});