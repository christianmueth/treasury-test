import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { safeUpsertUser } from "@/lib/db";
import { createReasoningEngine } from "@/lib/reasoningEngine/engine";
import { persistReasoningResponseRun } from "@/lib/reasoningEngine/persistence";
import { classifyMisconceptionSignalsFromVerification, updateStudentStateFromVerification } from "@/lib/reasoningEngine/studentState";

const reasoningEngine = createReasoningEngine({
  beamWidth: Number(process.env.REASONING_ENGINE_BEAM_WIDTH || 3),
  maxAttempts: Number(process.env.REASONING_ENGINE_MAX_ATTEMPTS || 3),
});

type VerifyRequestBody =
  | {
      mode?: "answer";
      prompt?: string;
      answer?: string;
      expectedAnswer?: string;
      title?: string;
      origin?: string;
      persist?: boolean;
    }
  | {
      mode: "compare";
      prompt?: string;
      explanationA?: string;
      explanationB?: string;
      title?: string;
      origin?: string;
      persist?: boolean;
    };

type VerifyAnswerBody = Extract<VerifyRequestBody, { mode?: "answer" }>;
type CompareBody = Extract<VerifyRequestBody, { mode: "compare" }>;

export async function POST(req: Request) {
  const traceId = req.headers.get("x-quickstud-trace") || (globalThis.crypto as any)?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const testKey = process.env.FLASHCARDS_TEST_KEY;
  const isTestMode = !!testKey && req.headers.get("x-flashcards-test-key") === testKey;

  let clerkUserId: string | null = null;
  if (!isTestMode) {
    const authResult = await auth();
    clerkUserId = authResult.userId;
    if (!clerkUserId) {
      return NextResponse.json({ error: "Unauthorized", traceId }, { status: 401 });
    }
  }

  const body = (await req.json().catch(() => null)) as VerifyRequestBody | null;
  if (!body?.prompt?.trim()) {
    return NextResponse.json({ error: "Prompt is required", traceId }, { status: 400 });
  }

  const mode = body.mode === "compare" ? "compare" : "answer";
  const persist = body.persist !== false && !isTestMode;

  try {
    let response;
    let reasoningMode: "verify_answer" | "compare_explanations";
    let metadata: Prisma.InputJsonValue;
    let misconceptionSignals: string[] = [];

    if (mode === "compare") {
      const compareBody = body as CompareBody;
      const explanationA = compareBody.explanationA?.trim();
      const explanationB = compareBody.explanationB?.trim();
      if (!explanationA || !explanationB) {
        return NextResponse.json({ error: "Both explanationA and explanationB are required", traceId }, { status: 400 });
      }

      response = await reasoningEngine.compareExplanations({
        prompt: body.prompt.trim(),
        explanationA,
        explanationB,
      });
      reasoningMode = "compare_explanations";
      misconceptionSignals = classifyMisconceptionSignalsFromVerification({
        userId: "",
        mode: reasoningMode,
        prompt: body.prompt,
        response,
      });
      metadata = {
        promptPreview: truncate(body.prompt),
        explanationAPreview: truncate(explanationA),
        explanationBPreview: truncate(explanationB),
        misconceptionSignals,
      };
    } else {
      const answerBody = body as VerifyAnswerBody;
      const answer = answerBody.answer?.trim();
      if (!answer) {
        return NextResponse.json({ error: "Answer is required", traceId }, { status: 400 });
      }

      response = await reasoningEngine.verify({
        prompt: body.prompt.trim(),
        answer,
        expectedAnswer: answerBody.expectedAnswer?.trim(),
      });
      reasoningMode = "verify_answer";
      misconceptionSignals = classifyMisconceptionSignalsFromVerification({
        userId: "",
        mode: reasoningMode,
        prompt: body.prompt,
        response,
        answer,
        expectedAnswer: answerBody.expectedAnswer?.trim(),
      });
      metadata = {
        promptPreview: truncate(body.prompt),
        answerPreview: truncate(answer),
        expectedAnswerProvided: !!answerBody.expectedAnswer?.trim(),
        misconceptionSignals,
      };
    }

    let reasoningRunId: string | null = null;
    if (persist) {
      const user = await safeUpsertUser(clerkUserId!, { id: true });

      if (user) {
        const saved = await persistReasoningResponseRun({
          userId: user.id,
          mode: reasoningMode,
          origin: body.origin,
          title: body.title,
          prompt: body.prompt,
          response,
          verificationApplied: true,
          metadata,
        });
        reasoningRunId = saved.id;

        await updateStudentStateFromVerification({
          userId: user.id,
          mode: reasoningMode as "verify_answer" | "compare_explanations",
          prompt: body.prompt,
          response,
          answer: mode === "answer" ? (body as VerifyAnswerBody).answer?.trim() : undefined,
          expectedAnswer: mode === "answer" ? (body as VerifyAnswerBody).expectedAnswer?.trim() : undefined,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      mode,
      reasoning: response,
      reasoningRunId,
      persisted: persist && !!reasoningRunId,
      degraded: persist && !reasoningRunId,
      traceId,
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        error: error?.message || "Verification failed",
        traceId,
      },
      { status: 500 }
    );
  }
}

function truncate(value?: string, max = 240) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}