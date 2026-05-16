import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { prisma, safeUpsertUser } from "@/lib/db";
import { chatV1, type ChatV1Message } from "@/lib/aiGateway";
import { formatStudentState } from "@/lib/reasoningEngine/studentState";
import { sanitizeTutorChatSessionContext, type TutorChatSessionContext } from "@/lib/tutorChatSessionContext";
import { sanitizeWorkspaceContext, summarizeWorkspaceContext, type WorkspaceContext } from "@/lib/workspaceContext";
import { buildWorkspaceConstitutionPrompt } from "@/lib/workspaceConstitution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TutorChatRequest = {
  message?: string;
  path?: string;
  deckId?: string | null;
  focusConcept?: string | null;
  focusReason?: string | null;
  liveContext?: TutorChatSessionContext | null;
  workspaceContext?: WorkspaceContext | null;
};

type TutorChatHistoryItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export async function GET(req: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    }

    const requestUrl = new URL(req.url);
    const requestedDeckId = cleanQueryValue(requestUrl.searchParams.get("deckId"));
    const user = await prisma.user.findUnique({
      where: { clerkUserId },
      select: {
        id: true,
        studentState: true,
      },
    });

    if (!user) {
      return NextResponse.json({
        ok: true,
        messages: [],
        context: buildEmptyContext(),
      });
    }

    const deck = requestedDeckId ? await loadOwnedDeck(user.id, requestedDeckId) : null;
    const studentState = formatStudentState(user.studentState);
    const recentRuns = await prisma.reasoningRun.findMany({
      where: {
        userId: user.id,
        mode: { in: ["tutor_chat", "tutor_guidance", "study_recovery", "verify_answer", "compare_explanations"] },
        ...(deck ? { OR: [{ deckId: deck.id }, { deckId: null }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 16,
      select: {
        id: true,
        mode: true,
        prompt: true,
        finalAnswer: true,
        title: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      ok: true,
      messages: toHistory(recentRuns),
      context: buildContextSnapshot({ studentState, deck, recentRuns }),
    });
  } catch (error) {
    console.error("[TutorChat] GET failed:", error);
    return NextResponse.json({
      ok: true,
      messages: [],
      context: buildEmptyContext(),
    });
  }
}

export async function POST(req: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
    }

    const body = (await req.json()) as TutorChatRequest;
    const message = cleanMessage(body.message);
    const liveContext = sanitizeTutorChatSessionContext(body.liveContext);
    const workspaceContext = sanitizeWorkspaceContext(body.workspaceContext);
    if (!message) {
      return NextResponse.json({ error: "Message is required", code: "BAD_REQUEST" }, { status: 400 });
    }

    const user = await safeUpsertUser(clerkUserId, {
      id: true,
      studentState: true,
    });

    const deck = user && body.deckId ? await loadOwnedDeck(user.id, body.deckId) : null;
    const studentState = user ? formatStudentState(user.studentState) : formatStudentState(null);
    const recentRuns = user
      ? await prisma.reasoningRun.findMany({
          where: {
            userId: user.id,
            mode: { in: ["tutor_chat", "tutor_guidance", "study_recovery", "verify_answer", "compare_explanations"] },
            ...(deck ? { OR: [{ deckId: deck.id }, { deckId: null }] } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 12,
          select: {
            id: true,
            mode: true,
            prompt: true,
            finalAnswer: true,
            title: true,
            createdAt: true,
          },
        })
      : [];

    const messages: ChatV1Message[] = [
      {
        role: "system",
        content: buildSystemPrompt({
          path: cleanQueryValue(body.path),
          focusConcept: cleanQueryValue(body.focusConcept),
          focusReason: cleanQueryValue(body.focusReason),
          liveContext,
          workspaceContext,
          deck,
          studentState,
          recentRuns,
        }),
      },
      ...toModelHistory(recentRuns),
      { role: "user", content: message },
    ];

    const response = await chatV1({
      messages,
      temperature: 0.4,
      max_output_tokens: 500,
    });

    const assistantMessage = sanitizeAssistantMessage(response.output_text);

    const savedRun = user
      ? await prisma.reasoningRun.create({
          data: {
            userId: user.id,
            deckId: deck?.id ?? null,
            mode: "tutor_chat",
            origin: "persistent_tutor_panel",
            title: deck?.title ?? "Workspace tutor chat",
            prompt: message,
            finalAnswer: assistantMessage,
            metadata: {
              path: cleanQueryValue(body.path),
              focusConcept: cleanQueryValue(body.focusConcept),
              focusReason: cleanQueryValue(body.focusReason),
              weakConcepts: studentState.weakConcepts.slice(0, 3),
              preferredExplanationStyle: studentState.preferredExplanationStyle,
              liveContext,
              workspaceContext,
            } as Prisma.InputJsonValue,
          },
          select: {
            id: true,
            createdAt: true,
          },
        })
      : {
          id: `msg_${Date.now()}`,
          createdAt: new Date(),
        };

    return NextResponse.json({
      ok: true,
      message: {
        id: savedRun.id,
        role: "assistant",
        content: assistantMessage,
        createdAt: savedRun.createdAt.toISOString(),
      },
      context: buildContextSnapshot({ studentState, deck, recentRuns }),
      degraded: !user,
    });
  } catch (error) {
    console.error("[TutorChat] POST failed:", error);
    return NextResponse.json({ error: "We couldn't respond right now.", code: "CHAT_UNAVAILABLE" }, { status: 500 });
  }
}

async function loadOwnedDeck(userId: string, deckId: string) {
  const cleanDeckId = cleanQueryValue(deckId);
  if (!cleanDeckId) return null;

  return prisma.deck.findFirst({
    where: { id: cleanDeckId, userId },
    select: {
      id: true,
      title: true,
      _count: { select: { cards: true } },
    },
  });
}

function toHistory(
  runs: Array<{
    id: string;
    mode: string;
    prompt: string | null;
    finalAnswer: string | null;
    createdAt: Date;
  }>
): TutorChatHistoryItem[] {
  return runs
    .filter((run) => run.mode === "tutor_chat")
    .reverse()
    .flatMap((run) => {
      const messages: TutorChatHistoryItem[] = [];
      if (run.prompt?.trim()) {
        messages.push({
          id: `${run.id}-user`,
          role: "user",
          content: run.prompt.trim(),
          createdAt: run.createdAt.toISOString(),
        });
      }
      if (run.finalAnswer?.trim()) {
        messages.push({
          id: `${run.id}-assistant`,
          role: "assistant",
          content: run.finalAnswer.trim(),
          createdAt: run.createdAt.toISOString(),
        });
      }
      return messages;
    })
    .slice(-14);
}

function toModelHistory(
  runs: Array<{
    mode: string;
    prompt: string | null;
    finalAnswer: string | null;
  }>
): ChatV1Message[] {
  return runs
    .filter((run) => run.mode === "tutor_chat")
    .reverse()
    .flatMap((run) => {
      const messages: ChatV1Message[] = [];
      if (run.prompt?.trim()) messages.push({ role: "user", content: run.prompt.trim() });
      if (run.finalAnswer?.trim()) messages.push({ role: "assistant", content: run.finalAnswer.trim() });
      return messages;
    })
    .slice(-10);
}

function buildContextSnapshot({
  studentState,
  deck,
  recentRuns,
}: {
  studentState: ReturnType<typeof formatStudentState>;
  deck: { id: string; title: string; _count: { cards: number } } | null;
  recentRuns: Array<{ mode: string; title: string | null; createdAt: Date }>;
}) {
  const recentModes = recentRuns
    .filter((run) => run.mode !== "tutor_chat")
    .slice(0, 3)
    .map((run) => summarizeRun(run.mode, run.title));

  return {
    deckTitle: deck?.title ?? null,
    cardCount: deck?._count.cards ?? null,
    weakConcepts: studentState.weakConcepts.slice(0, 3),
    recentSuccesses: studentState.recentSuccesses.slice(0, 2),
    recentFailures: studentState.recentFailures.slice(0, 2),
    explanationStyle: studentState.preferredExplanationStyle,
    lowConfidenceStreak: studentState.pacingProfile.lowConfidenceStreak,
    recentGuidance: recentModes,
  };
}

function buildEmptyContext() {
  return {
    deckTitle: null,
    cardCount: null,
    weakConcepts: [] as string[],
    recentSuccesses: [] as string[],
    recentFailures: [] as string[],
    explanationStyle: null,
    lowConfidenceStreak: 0,
    recentGuidance: [] as string[],
  };
}

function buildSystemPrompt({
  path,
  focusConcept,
  focusReason,
  liveContext,
  workspaceContext,
  deck,
  studentState,
  recentRuns,
}: {
  path: string | null;
  focusConcept: string | null;
  focusReason: string | null;
  liveContext: TutorChatSessionContext | null;
  workspaceContext: WorkspaceContext | null;
  deck: { id: string; title: string; _count: { cards: number } } | null;
  studentState: ReturnType<typeof formatStudentState>;
  recentRuns: Array<{ mode: string; title: string | null; createdAt: Date }>;
}) {
  const recentGuidance = recentRuns
    .filter((run) => run.mode !== "tutor_chat")
    .slice(0, 5)
    .map((run) => `- ${summarizeRun(run.mode, run.title)}`)
    .join("\n");

  return [
    buildWorkspaceConstitutionPrompt([
      "You are the persistent Mate-E tutor inside the student's workspace.",
      "Your job is to give calm, bounded instructional guidance that feels continuous across sessions.",
      "Never claim hidden powers. Never say you changed the queue, updated settings, or took actions on the student's behalf.",
      "You may explain, suggest, summarize, and recommend a next study move, but you cannot execute study actions.",
      "Keep answers concise, specific, and educationally useful. Prefer 2 short paragraphs or a short list.",
      "Avoid the terms AI assistant, agent, planner, system state, or policy unless the student directly asks about internals.",
      "When relevant, mention continuity naturally, such as prior hesitation, recent recovery, or a stabilized concept.",
      "If context is thin, say what you can see and ask one targeted follow-up question.",
    ]),
    "",
    `Current route: ${path || "/app"}`,
    `Current deck: ${deck ? `${deck.title} (${deck._count.cards} cards)` : "workspace-wide view"}`,
    `Focus concept: ${focusConcept || "none"}`,
    `Why this focus was chosen: ${focusReason || "not specified"}`,
    `Live study context: ${formatLiveContextSummary(liveContext)}`,
    `Active workspace context: ${summarizeWorkspaceContext(workspaceContext)}`,
    `World model read: ${formatWorldModelSummary(liveContext)}`,
    `Weak concepts: ${formatList(studentState.weakConcepts, "none recorded")}`,
    `Recent recovery needs: ${formatList(studentState.recentFailures, "none recorded")}`,
    `Recent wins: ${formatList(studentState.recentSuccesses, "none recorded")}`,
    `Preferred explanation style: ${studentState.preferredExplanationStyle || "not learned yet"}`,
    `Low-confidence streak: ${studentState.pacingProfile.lowConfidenceStreak}`,
    "Recent tutoring context:",
    recentGuidance || "- No recent tutoring runs recorded.",
  ].join("\n");
}

function summarizeRun(mode: string, title: string | null) {
  const label =
    mode === "tutor_guidance"
      ? "recent inline coaching"
      : mode === "study_recovery"
        ? "recent recovery summary"
        : mode === "verify_answer"
          ? "recent answer check"
          : mode === "compare_explanations"
            ? "recent explanation comparison"
            : mode.replace(/_/g, " ");

  return title?.trim() ? `${label}: ${title.trim()}` : label;
}

function sanitizeAssistantMessage(value: string) {
  const text = String(value || "").trim();
  if (!text) {
    return "I can help you work through the concept in front of you, but I need a little more detail about what feels unclear.";
  }

  return text.length > 2400 ? `${text.slice(0, 2400).trim()}...` : text;
}

function cleanMessage(value: string | undefined) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 1500);
}

function cleanQueryValue(value: string | null | undefined) {
  const text = String(value || "").trim();
  return text || null;
}

function formatList(items: string[], fallback: string) {
  return items.length ? items.slice(0, 4).join(", ") : fallback;
}

function formatLiveContextSummary(liveContext: TutorChatSessionContext | null) {
  if (!liveContext?.currentCard) return "no active card context";

  const parts = [
    `active prompt: ${liveContext.currentCard.question}`,
    liveContext.queuePosition ? `queue position ${liveContext.queuePosition.current}/${liveContext.queuePosition.total}` : null,
    liveContext.answerDraft ? `student draft: ${liveContext.answerDraft}` : null,
    liveContext.latestCoaching?.hint ? `latest hint: ${liveContext.latestCoaching.hint}` : null,
    liveContext.latestCoaching?.misconceptionSignals.length
      ? `misconceptions: ${liveContext.latestCoaching.misconceptionSignals.join(", ")}`
      : null,
  ];

  return parts.filter(Boolean).join(" | ");
}

function formatWorldModelSummary(liveContext: TutorChatSessionContext | null) {
  const coaching = liveContext?.latestCoaching;
  if (!coaching?.worldModelExplanation) return "no active transition estimate";

  const parts = [
    coaching.worldModelExplanation,
    typeof coaching.projectedConfidenceDelta === "number"
      ? `projected confidence delta ${coaching.projectedConfidenceDelta}`
      : null,
    typeof coaching.projectedRecoveryProbability === "number"
      ? `projected recovery ${coaching.projectedRecoveryProbability}`
      : null,
    typeof coaching.projectedStabilityGain === "number"
      ? `projected stability gain ${coaching.projectedStabilityGain}`
      : null,
  ];

  return parts.filter(Boolean).join(" | ");
}