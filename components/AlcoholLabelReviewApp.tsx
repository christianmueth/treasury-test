"use client";

import { useState } from "react";

type ManualApplicationData = {
  brand_name: string;
  class_type: string;
  abv: string;
  proof: string;
  net_contents: string;
};

type ReviewCheck = {
  key: string;
  label: string;
  status: "pass" | "fail" | "manual";
  expected: string;
  actual: string;
  confidence: number;
  explanation: string;
};

type ReviewResult = {
  applicationData: Record<string, string>;
  extracted: {
    raw_text: string;
    fields: Record<string, string | undefined>;
    image_quality_issues: string[];
    ambiguities: string[];
  };
  checks: ReviewCheck[];
  overallRecommendation: "pass" | "manual_review" | "reject";
  summary: string;
  criticalFindings: string[];
};

type BatchResult = {
  fileName: string;
  review?: ReviewResult;
  error?: string;
  totalMs?: number;
};

type SampleScenario = {
  id: string;
  title: string;
  labelFileName: string;
  labelUrl: string;
  expectedOutcome: "pass" | "manual_review" | "reject";
  reason: string;
  metadata: ManualApplicationData;
};

const SAMPLE_JSON = `{
  "brand_name": "OLD TOM DISTILLERY",
  "class_type": "Kentucky Straight Bourbon Whiskey",
  "abv": "45%",
  "proof": "90",
  "net_contents": "750 mL"
}`;

const SAMPLE_SCENARIOS: SampleScenario[] = [
  {
    id: "perfect-match",
    title: "Perfect match",
    labelFileName: "perfect-match.png",
    labelUrl: "/label-review-samples/perfect-match.png",
    expectedOutcome: "pass",
    reason: "All core fields and the government warning align with the application data.",
    metadata: {
      brand_name: "OLD TOM DISTILLERY",
      class_type: "Kentucky Straight Bourbon Whiskey",
      abv: "45%",
      proof: "90",
      net_contents: "750 mL",
    },
  },
  {
    id: "fuzzy-match",
    title: "Fuzzy match",
    labelFileName: "fuzzy-match.png",
    labelUrl: "/label-review-samples/fuzzy-match.png",
    expectedOutcome: "manual_review",
    reason: "Case and punctuation differences should steer the reviewer toward manual review instead of an automatic reject.",
    metadata: {
      brand_name: "Stone's Throw",
      class_type: "Dry Gin",
      abv: "42%",
      proof: "84",
      net_contents: "700 mL",
    },
  },
  {
    id: "warning-mismatch",
    title: "Warning mismatch",
    labelFileName: "warning-mismatch.png",
    labelUrl: "/label-review-samples/warning-mismatch.png",
    expectedOutcome: "reject",
    reason: "The warning heading uses title case rather than the required all-caps format.",
    metadata: {
      brand_name: "HARBOR LANE CELLARS",
      class_type: "Red Wine",
      abv: "13.5%",
      proof: "",
      net_contents: "750 mL",
    },
  },
];

export default function AlcoholLabelReviewApp() {
  const [files, setFiles] = useState<File[]>([]);
  const [applicationJson, setApplicationJson] = useState(SAMPLE_JSON);
  const [manualApplication, setManualApplication] = useState<ManualApplicationData>({
    brand_name: "OLD TOM DISTILLERY",
    class_type: "Kentucky Straight Bourbon Whiskey",
    abv: "45%",
    proof: "90",
    net_contents: "750 mL",
  });
  const [results, setResults] = useState<BatchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);

  function updateManualField(key: keyof ManualApplicationData, value: string) {
    setManualApplication((current) => {
      const next = { ...current, [key]: value };
      setApplicationJson(JSON.stringify(next, null, 2));
      return next;
    });
  }

  function handleApplicationJsonChange(value: string) {
    setApplicationJson(value);
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setManualApplication({
          brand_name: String(parsed.brand_name || ""),
          class_type: String(parsed.class_type || ""),
          abv: String(parsed.abv || ""),
          proof: String(parsed.proof || ""),
          net_contents: String(parsed.net_contents || ""),
        });
      }
    } catch {
      // Keep the textarea editable even when JSON is temporarily invalid.
    }
  }

  async function loadScenario(scenario: SampleScenario) {
    if (loading) return;
    setError(null);
    setActiveScenarioId(scenario.id);
    setManualApplication(scenario.metadata);
    setApplicationJson(JSON.stringify(scenario.metadata, null, 2));
    setResults([]);

    try {
      const response = await fetch(scenario.labelUrl);
      if (!response.ok) {
        throw new Error(`Sample label could not be loaded (${response.status}).`);
      }

      const blob = await response.blob();
      const file = new File([blob], scenario.labelFileName, { type: blob.type || "image/png" });
      setFiles([file]);
      await analyzeFiles([file], [scenario.metadata]);
    } catch (scenarioError) {
      setFiles([]);
      setActiveScenarioId(null);
      setError(scenarioError instanceof Error ? scenarioError.message : "Sample scenario could not be loaded.");
    }
  }

  async function handleAnalyze() {
    if (!files.length || loading) return;

    try {
      const parsed = JSON.parse(applicationJson);
      const payloads = Array.isArray(parsed) ? parsed : [parsed];

      if (files.length > 1 && payloads.length !== files.length) {
        throw new Error("For batch review, provide a JSON array with one application object per uploaded file in the same order.");
      }
      await analyzeFiles(files, payloads);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Review failed.");
    }
  }

  async function analyzeFiles(selectedFiles: File[], payloads: unknown[]) {
    setLoading(true);
    setError(null);
    setResults([]);

    try {
      const nextResults = await Promise.all(
        selectedFiles.map(async (file, index) => {
          const formData = new FormData();
          formData.append("label", file);
          formData.append("applicationData", JSON.stringify(payloads[Math.min(index, payloads.length - 1)]));

          const response = await fetch("/api/label-review", {
            method: "POST",
            body: formData,
          });

          const data = await safeJson(response);
          if (!response.ok || !data?.ok) {
            return {
              fileName: file.name,
              error: data?.error || "Review failed.",
            } satisfies BatchResult;
          }

          return {
            fileName: file.name,
            review: data.review as ReviewResult,
            totalMs: Number(data?.timings?.total_ms || 0),
          } satisfies BatchResult;
        })
      );

      setResults(nextResults);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "Review failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8 p-4 md:p-6">
      <section className="rounded-[2rem] border border-amber-200 bg-[radial-gradient(circle_at_top_left,_rgba(180,83,9,0.16),_transparent_34%),linear-gradient(135deg,_#fff8ee_0%,_#fffdf8_48%,_#f5efe4_100%)] p-6 shadow-[0_24px_80px_rgba(120,53,15,0.10)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-800">Treasury Prototype</p>
            <h1 className="text-3xl font-semibold tracking-tight text-stone-950 sm:text-4xl">Alcohol label verification in one review screen.</h1>
            <p className="text-sm leading-7 text-stone-700 sm:text-base">
              Upload one label or a batch, paste the application JSON, and get a field-by-field pass, fail, or manual-review readout.
            </p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-white/80 px-4 py-3 text-sm text-stone-700 shadow-sm">
            <div>Designed for fast review, with local PDF extraction where possible</div>
            <div>Supported files: PNG, JPG, PDF</div>
          </div>
        </div>
      </section>

      <section className="rounded-[1.75rem] border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Demo mode</p>
            <h2 className="mt-2 text-xl font-semibold text-stone-950">Load a sample in one click.</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              These bundled scenarios are meant for 60-second evaluation: one likely approval, one fuzzy match that should lean toward manual review, and one warning mismatch that should likely be rejected.
            </p>
          </div>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          {SAMPLE_SCENARIOS.map((scenario) => (
            <article key={scenario.id} className={scenario.id === activeScenarioId ? "rounded-3xl border border-amber-300 bg-amber-50 p-4 shadow-sm" : "rounded-3xl border border-stone-200 bg-stone-50 p-4"}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-stone-950">{scenario.title}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">Expected: {verdictLabel(scenario.expectedOutcome)}</p>
                </div>
                <StatusBadge status={scenario.expectedOutcome} />
              </div>
              <p className="mt-3 text-sm leading-6 text-stone-700">{scenario.reason}</p>
              <button
                type="button"
                onClick={() => void loadScenario(scenario)}
                className="mt-4 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-900 hover:bg-stone-100"
              >
                Load sample
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.92fr_1.08fr]">
        <div className="rounded-[1.75rem] border border-stone-200 bg-white p-5 shadow-sm">
          <div className="space-y-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Step 1</p>
              <h2 className="mt-2 text-xl font-semibold text-stone-950">Upload labels</h2>
              <p className="mt-2 text-sm leading-6 text-stone-600">Use one file for a single review or multiple files for batch mode.</p>
            </div>

            <label className="block rounded-3xl border border-dashed border-amber-300 bg-amber-50/60 p-5 text-sm text-stone-700">
              <span className="font-medium text-stone-900">Label files</span>
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
                multiple
                className="mt-3 block w-full text-sm"
                onChange={(event) => setFiles(Array.from(event.target.files || []))}
              />
            </label>

            <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">Queued labels</p>
              <div className="mt-3 space-y-2">
                {files.length === 0 ? (
                  <p className="text-sm text-stone-500">No files selected yet.</p>
                ) : (
                  files.map((file) => (
                    <div key={`${file.name}-${file.size}`} className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700">
                      <span className="truncate">{file.name}</span>
                      <span className="text-stone-500">{formatFileSize(file.size)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Step 2</p>
              <h2 className="mt-2 text-xl font-semibold text-stone-950">Paste application JSON</h2>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                For batch review, provide a JSON array with one object per file in the same order.
              </p>
            </div>

            <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">Manual entry</p>
              <p className="mt-2 text-sm leading-6 text-stone-600">
                For a single label, you can fill these fields instead of editing JSON directly. The form stays synced to the JSON payload below.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block text-sm text-stone-700">
                  Brand name
                  <input value={manualApplication.brand_name} onChange={(event) => updateManualField("brand_name", event.target.value)} className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-amber-500" />
                </label>
                <label className="block text-sm text-stone-700">
                  Class/type
                  <input value={manualApplication.class_type} onChange={(event) => updateManualField("class_type", event.target.value)} className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-amber-500" />
                </label>
                <label className="block text-sm text-stone-700">
                  ABV
                  <input value={manualApplication.abv} onChange={(event) => updateManualField("abv", event.target.value)} className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-amber-500" />
                </label>
                <label className="block text-sm text-stone-700">
                  Proof
                  <input value={manualApplication.proof} onChange={(event) => updateManualField("proof", event.target.value)} className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-amber-500" />
                </label>
                <label className="block text-sm text-stone-700 sm:col-span-2">
                  Net contents
                  <input value={manualApplication.net_contents} onChange={(event) => updateManualField("net_contents", event.target.value)} className="mt-2 w-full rounded-2xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-amber-500" />
                </label>
              </div>
            </div>

            <textarea
              value={applicationJson}
              onChange={(event) => handleApplicationJsonChange(event.target.value)}
              spellCheck={false}
              className="min-h-[300px] w-full rounded-3xl border border-stone-300 bg-stone-950 p-4 font-mono text-sm text-amber-50 outline-none focus:border-amber-500"
            />

            {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

            <button
              type="button"
              onClick={handleAnalyze}
              disabled={loading || files.length === 0}
              className="w-full rounded-full bg-amber-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {loading ? "Reviewing labels..." : files.length > 1 ? "Review batch" : "Review label"}
            </button>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-[1.75rem] border border-stone-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Output</p>
            <h2 className="mt-2 text-xl font-semibold text-stone-950">Clear pass/fail review dashboard</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              Each result shows expected vs. extracted values, mismatch explanations, warning validation, and whether the label can pass or needs manual review.
            </p>
          </div>

          {results.length === 0 ? (
            <div className="rounded-[1.75rem] border border-dashed border-stone-300 bg-white/70 p-8 text-sm text-stone-500 shadow-sm">
              Select a sample scenario or upload a label to begin review.
            </div>
          ) : (
            results.map((result) => (
              <article key={result.fileName} className="rounded-[1.75rem] border border-stone-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-3 border-b border-stone-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Label file</p>
                    <h3 className="mt-2 text-lg font-semibold text-stone-950">{result.fileName}</h3>
                    {typeof result.totalMs === "number" && result.totalMs > 0 ? (
                      <p className="mt-1 text-sm text-stone-500">Processed in {result.totalMs} ms</p>
                    ) : null}
                  </div>
                  <StatusBadge status={result.review?.overallRecommendation || (result.error ? "reject" : "manual_review")} />
                </div>

                {result.error ? (
                  <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{result.error}</div>
                ) : result.review ? (
                  <div className="mt-4 space-y-5">
                    <VerdictBanner review={result.review} />

                    <FieldComparisonGrid checks={result.review.checks} />

                    <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                      <div className="overflow-hidden rounded-3xl border border-stone-200">
                        <table className="w-full border-collapse text-left text-sm">
                          <thead className="bg-stone-100 text-stone-700">
                            <tr>
                              <th className="px-4 py-3 font-medium">Check</th>
                              <th className="px-4 py-3 font-medium">Application</th>
                              <th className="px-4 py-3 font-medium">Extracted</th>
                              <th className="px-4 py-3 font-medium">Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {result.review.checks.map((check) => (
                              <tr key={check.key} className="border-t border-stone-200 align-top">
                                <td className="px-4 py-3">
                                  <div className="font-medium text-stone-900">{check.label}</div>
                                  <div className="mt-1 text-xs leading-5 text-stone-500">{check.explanation}</div>
                                </td>
                                <td className="px-4 py-3 text-stone-700">{check.expected || "-"}</td>
                                <td className="px-4 py-3 text-stone-700">{check.actual || "-"}</td>
                                <td className="px-4 py-3">
                                  <InlineStatus status={check.status} confidence={check.confidence} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="space-y-4">
                        <InfoCard title="Critical findings" items={result.review.criticalFindings} emptyLabel="No critical findings." />
                        <InfoCard title="Image quality flags" items={result.review.extracted.image_quality_issues} emptyLabel="No image quality issues reported." />
                        <InfoCard title="Ambiguities" items={result.review.extracted.ambiguities} emptyLabel="No extraction ambiguities reported." />
                      </div>
                    </div>

                    <details className="rounded-3xl border border-stone-200 bg-stone-50 px-4 py-3">
                      <summary className="cursor-pointer text-sm font-medium text-stone-900">Show extracted label text</summary>
                      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-stone-700">{result.review.extracted.raw_text || "No raw text returned."}</pre>
                    </details>
                  </div>
                ) : null}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function VerdictBanner({ review }: { review: ReviewResult }) {
  const passCount = review.checks.filter((check) => check.status === "pass").length;
  const manualCount = review.checks.filter((check) => check.status === "manual").length;
  const failCount = review.checks.filter((check) => check.status === "fail").length;
  const tone =
    review.overallRecommendation === "pass"
      ? "border-emerald-200 bg-emerald-50 text-emerald-950"
      : review.overallRecommendation === "manual_review"
        ? "border-amber-200 bg-amber-50 text-amber-950"
        : "border-rose-200 bg-rose-50 text-rose-950";

  const subcopy =
    review.overallRecommendation === "pass"
      ? "Core checks align closely enough for likely approval, subject to final reviewer judgment."
      : review.overallRecommendation === "manual_review"
        ? "At least one field needs a human read before approval."
        : "One or more required checks failed and likely justify rejection or return for correction.";

  return (
    <section className={`rounded-3xl border px-5 py-4 ${tone}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-80">Reviewer summary</p>
          <h4 className="mt-2 text-2xl font-semibold">{verdictLabel(review.overallRecommendation)}</h4>
          <p className="mt-2 text-sm leading-6 opacity-90">{subcopy}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
            <span className="rounded-full bg-white/70 px-3 py-1 text-stone-700">{passCount} passed</span>
            <span className="rounded-full bg-white/70 px-3 py-1 text-stone-700">{manualCount} manual review</span>
            <span className="rounded-full bg-white/70 px-3 py-1 text-stone-700">{failCount} failed</span>
          </div>
        </div>
        <StatusBadge status={review.overallRecommendation} />
      </div>
      <div className="mt-4 rounded-2xl bg-white/70 px-4 py-3 text-sm text-stone-700">{review.summary}</div>
    </section>
  );
}

function FieldComparisonGrid({ checks }: { checks: ReviewCheck[] }) {
  return (
    <section className="rounded-3xl border border-stone-200 bg-stone-50 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">Reviewer evidence</p>
          <h4 className="mt-2 text-lg font-semibold text-stone-950">Application values beside extracted values</h4>
        </div>
        <p className="text-xs leading-5 text-stone-500">Confidence indicates extraction confidence, not autonomous approval confidence.</p>
      </div>

      <div className="mt-4 grid gap-2 rounded-3xl border border-stone-200 bg-white p-4 text-xs leading-5 text-stone-600 lg:grid-cols-3">
        <div>
          <p className="font-semibold uppercase tracking-[0.16em] text-stone-500">85-100%</p>
          <p className="mt-1">High extraction signal. The text was captured cleanly, but the rule result still controls the decision.</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-[0.16em] text-stone-500">60-84%</p>
          <p className="mt-1">Usable extraction with some uncertainty. Review the extracted value closely before trusting a near match.</p>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-[0.16em] text-stone-500">Below 60%</p>
          <p className="mt-1">Weak extraction signal. Treat the value as suspect and rely on manual review or the raw label text.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        {checks.map((check) => (
          <article key={`comparison-${check.key}`} className="rounded-3xl border border-stone-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-stone-950">{check.label}</p>
                <p className="mt-1 text-xs leading-5 text-stone-500">{check.explanation}</p>
              </div>
              <InlineStatus status={check.status} confidence={check.confidence} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ComparisonValueCard label="Application" value={check.expected} />
              <ComparisonValueCard label="Extracted" value={check.actual} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ComparisonValueCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">{label}</p>
      <p className="mt-2 break-words text-sm leading-6 text-stone-900">{value || "-"}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: "pass" | "manual_review" | "reject" }) {
  const copy = verdictLabel(status);
  const tone =
    status === "pass"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "manual_review"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-rose-200 bg-rose-50 text-rose-800";
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${tone}`}>{copy}</span>;
}

function InlineStatus({ status, confidence }: { status: "pass" | "fail" | "manual"; confidence: number }) {
  const tone =
    status === "pass"
      ? "bg-emerald-100 text-emerald-800"
      : status === "manual"
        ? "bg-amber-100 text-amber-800"
        : "bg-rose-100 text-rose-800";
  const label = status === "pass" ? "Pass" : status === "manual" ? "Manual" : "Fail";

  return (
    <div className="space-y-1">
      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{label}</span>
      <div className="text-xs text-stone-500">Confidence {Math.round(confidence * 100)}%</div>
    </div>
  );
}

function InfoCard({ title, items, emptyLabel }: { title: string; items: string[]; emptyLabel: string }) {
  return (
    <section className="rounded-3xl border border-stone-200 bg-stone-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">{title}</p>
      <div className="mt-3 space-y-2 text-sm text-stone-700">
        {items.length === 0 ? (
          <p>{emptyLabel}</p>
        ) : (
          items.map((item) => (
            <div key={item} className="rounded-2xl border border-stone-200 bg-white px-3 py-2">
              {item}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

async function safeJson(response: Response) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function verdictLabel(status: "pass" | "manual_review" | "reject") {
  return status === "pass" ? "Likely Approved" : status === "manual_review" ? "Needs Manual Review" : "Likely Reject";
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}