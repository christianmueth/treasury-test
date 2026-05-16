import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { prisma, safeUpsertUser } from "@/lib/db";
import { createReasoningEngine, type TutoringGuidanceResult } from "@/lib/reasoningEngine/engine";
import { DEFAULT_TUTORING_POLICY_ARTIFACT, scoreTutoringStrategyWithArtifact } from "@/lib/reasoningEngine/adaptivePolicyArtifact";
import { persistReasoningResponseRun, mapTutoringStrategies } from "@/lib/reasoningEngine/persistence";
import { getStudentKnowledgeState, updateStudentStateFromVerification, formatStudentState } from "@/lib/reasoningEngine/studentState";
import { buildTutoringWorldModel } from "@/lib/reasoningEngine/worldModel";
import {
  applyMuonHelperLoop,
  getMuonHelperLoopConfig,
  type MuonHelperLoopConfig,
  type MuonHelperLoopOutcome,
  type MuonHelperLoopTelemetry,
} from "@/lib/reasoningEngine/muonHelperLoop";

const reasoningEngine = createReasoningEngine({
  beamWidth: Number(process.env.REASONING_ENGINE_BEAM_WIDTH || 3),
  maxAttempts: Number(process.env.REASONING_ENGINE_MAX_ATTEMPTS || 3),
});

type TutoringGuideBody = {
  prompt?: string;
  studentAnswer?: string;
  expectedAnswer?: string;
  title?: string;
  origin?: string;
  persist?: boolean;
};

type AdaptiveTutoringConfig = {
  enabled: boolean;
  shadowEnabled: boolean;
  blendWeight: number;
  abstainThreshold: number;
  worldModelBlendWeight: number;
  worldModelRiskPenalty: number;
  policyVersion: string;
  selectedPolicyLabel: string;
  scorerKind: string;
};

type AdaptiveCandidateScore = {
  strategyId: string;
  heuristicScore: number;
  artifactValueScore: number;
  blendedScore: number;
  worldModelScore: number | null;
  worldModelProjectedRecoveryProbability: number | null;
  worldModelProjectedStabilityGain: number | null;
  worldModelProjectedConfidenceDelta: number | null;
  worldModelProjectedLowConfidenceRisk: number | null;
  muonHelperScore: number | null;
  finalScore: number;
  helperSupport: number;
  heuristicSelected: boolean;
  adaptiveSelected: boolean;
  muonHelperSelected: boolean;
};

type AdaptiveTutoringTelemetry = {
  mode: "disabled" | "shadow" | "active";
  policyVersion: string;
  selectedPolicyLabel: string;
  scorerKind: string;
  blendWeight: number;
  abstainThreshold: number;
  worldModelBlendWeight: number;
  worldModelRiskPenalty: number;
  heuristicSelectedStrategyId: string;
  adaptiveSelectedStrategyId: string;
  effectiveSelectedStrategyId: string;
  disagreement: boolean;
  abstained: boolean;
  overrideApplied: boolean;
  artifactOverrideApplied: boolean;
  muonOverrideApplied: boolean;
  muonHelperLoop: MuonHelperLoopTelemetry | null;
  candidateScores: AdaptiveCandidateScore[];
};

export async function POST(req: Request) {
  const traceId = req.headers.get("x-quickstud-trace") || createTraceId();
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

  const body = (await req.json().catch(() => null)) as TutoringGuideBody | null;
  const prompt = body?.prompt?.trim();
  const studentAnswer = body?.studentAnswer?.trim();
  if (!prompt || !studentAnswer) {
    return NextResponse.json({ error: "Prompt and studentAnswer are required", traceId }, { status: 400 });
  }

  const persist = body?.persist !== false && !isTestMode;

  try {
    let userRow: { id: string } | null = null;
    let studentState;
    if (!isTestMode) {
      userRow = await safeUpsertUser(clerkUserId!, { id: true });
      studentState = userRow ? await getStudentKnowledgeState(userRow.id) : undefined;
    }

    const verification = await reasoningEngine.verify({
      prompt,
      answer: studentAnswer,
      expectedAnswer: body?.expectedAnswer?.trim(),
    });

    const guidance = await reasoningEngine.generateTutoringGuidance({
      prompt,
      studentAnswer,
      expectedAnswer: body?.expectedAnswer?.trim(),
      verification,
      studentState,
    });
    const rerankerWorldModel = buildTutoringWorldModel({
      prompt,
      studentAnswer,
      verification,
      studentState,
      weakTopicMatches: guidance.metadata.weakTopicMatches,
      misconceptionSignals: guidance.metadata.misconceptionSignals,
      strategies: guidance.metadata.candidateStrategies,
      selectedStrategyId: guidance.metadata.selectedStrategy.id,
    });
    const adaptiveConfig = getAdaptiveTutoringConfig();
    const muonConfig = getMuonHelperLoopConfig();
    const muonOutcomes = userRow && muonConfig.shadowEnabled
      ? await loadMuonHelperLoopOutcomes(userRow.id, muonConfig.recentRunLimit)
      : [];
    const { guidance: effectiveGuidance, telemetry: adaptiveTelemetry } = applyAdaptiveTutoringPolicy(guidance, adaptiveConfig, {
      config: muonConfig,
      outcomes: muonOutcomes,
    }, rerankerWorldModel);
    const worldModel = buildTutoringWorldModel({
      prompt,
      studentAnswer,
      verification,
      studentState,
      weakTopicMatches: effectiveGuidance.metadata.weakTopicMatches,
      misconceptionSignals: effectiveGuidance.metadata.misconceptionSignals,
      strategies: effectiveGuidance.metadata.candidateStrategies,
      selectedStrategyId: effectiveGuidance.metadata.selectedStrategy.id,
    });

    let reasoningRunId: string | null = null;
    let studentStateView = null;
    if (persist && userRow) {
      const saved = await persistReasoningResponseRun({
        userId: userRow.id,
        mode: "tutor_guidance",
        origin: body?.origin,
        title: body?.title,
        prompt,
        response: effectiveGuidance.response,
        verificationApplied: true,
        selectedCandidates: effectiveGuidance.metadata.candidateStrategies as unknown as Prisma.InputJsonValue,
        candidateRows: mapTutoringStrategies(effectiveGuidance.metadata.candidateStrategies),
        metadata: {
          verification,
          weakTopicMatches: effectiveGuidance.metadata.weakTopicMatches,
          misconceptionSignals: effectiveGuidance.metadata.misconceptionSignals,
          adaptivePolicy: adaptiveTelemetry,
          muonHelperLoop: adaptiveTelemetry?.muonHelperLoop || null,
          selectedStrategyProfile: {
            id: effectiveGuidance.metadata.selectedStrategy.id,
            label: effectiveGuidance.metadata.selectedStrategy.label,
            strategyType: effectiveGuidance.metadata.selectedStrategy.strategyType,
            strategyMode: effectiveGuidance.metadata.selectedStrategy.strategyMode,
          },
          worldModel,
        } as Prisma.InputJsonValue,
        candidatesGenerated: effectiveGuidance.metadata.candidateStrategies.length,
        candidatesSelected: 1,
        prunedCount: Math.max(0, effectiveGuidance.metadata.candidateStrategies.length - 1),
        averageCandidateScore:
          effectiveGuidance.metadata.candidateStrategies.reduce((sum, candidate) => sum + candidate.score, 0) /
          Math.max(1, effectiveGuidance.metadata.candidateStrategies.length),
        averageVerificationConfidence:
          effectiveGuidance.metadata.candidateStrategies.reduce((sum, candidate) => sum + candidate.confidence, 0) /
          Math.max(1, effectiveGuidance.metadata.candidateStrategies.length),
      });
      reasoningRunId = saved.id;

      await updateStudentStateFromVerification({
        userId: userRow.id,
        mode: "verify_answer",
        prompt,
        response: verification,
        answer: studentAnswer,
        expectedAnswer: body?.expectedAnswer?.trim(),
      });

      const refreshed = await prisma.studentState.findUnique({ where: { userId: userRow.id } });
      studentStateView = formatStudentState(refreshed);
    }

    return NextResponse.json({
      ok: true,
      mode: "tutor_guidance",
      verification,
      tutoring: effectiveGuidance.response,
      weakTopicMatches: effectiveGuidance.metadata.weakTopicMatches,
      misconceptionSignals: effectiveGuidance.metadata.misconceptionSignals,
      selectedStrategy: effectiveGuidance.metadata.selectedStrategy,
      candidateStrategies: effectiveGuidance.metadata.candidateStrategies,
      adaptivePolicy: adaptiveTelemetry,
      muonHelperLoop: adaptiveTelemetry?.muonHelperLoop || null,
      worldModel,
      reasoningRunId,
      persisted: persist && !!reasoningRunId,
      degraded: persist && !reasoningRunId,
      studentState: studentStateView,
      traceId,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: error instanceof Error && error.message ? error.message : "Failed to generate tutoring guidance",
        traceId,
      },
      { status: 500 }
    );
  }
}

function getAdaptiveTutoringConfig(): AdaptiveTutoringConfig {
  const enabled = process.env.TUTORING_ADAPTIVE_RERANK_ENABLED === "1";
  const shadowEnabled = enabled || process.env.TUTORING_ADAPTIVE_RERANK_SHADOW === "1";
  return {
    enabled,
    shadowEnabled,
    blendWeight: clamp(Number(process.env.TUTORING_ADAPTIVE_BLEND_WEIGHT || DEFAULT_TUTORING_POLICY_ARTIFACT.operatingPoint.blendWeight), 0, 1),
    abstainThreshold: clamp(Number(process.env.TUTORING_ADAPTIVE_ABSTAIN_THRESHOLD || DEFAULT_TUTORING_POLICY_ARTIFACT.operatingPoint.abstainThreshold), 0, 1),
    worldModelBlendWeight: clamp(Number(process.env.TUTORING_WORLD_MODEL_BLEND_WEIGHT || 0.18), 0, 0.4),
    worldModelRiskPenalty: clamp(Number(process.env.TUTORING_WORLD_MODEL_RISK_PENALTY || 0.08), 0, 0.25),
    policyVersion: process.env.TUTORING_ADAPTIVE_POLICY_VERSION || DEFAULT_TUTORING_POLICY_ARTIFACT.policyVersion,
    selectedPolicyLabel: DEFAULT_TUTORING_POLICY_ARTIFACT.selectedPolicyLabel,
    scorerKind: DEFAULT_TUTORING_POLICY_ARTIFACT.scorerKind,
  };
}

function applyAdaptiveTutoringPolicy(
  guidance: TutoringGuidanceResult,
  config: AdaptiveTutoringConfig,
  muonInput: {
    config: MuonHelperLoopConfig;
    outcomes: MuonHelperLoopOutcome[];
  },
  rerankerWorldModel: ReturnType<typeof buildTutoringWorldModel>
): { guidance: TutoringGuidanceResult; telemetry: AdaptiveTutoringTelemetry | null } {
  const heuristicSelected = guidance.metadata.selectedStrategy;
  const worldModelTransitions = new Map(
    rerankerWorldModel.candidateTransitions.map((transition) => [transition.strategyId, transition])
  );
  let candidateScores = guidance.metadata.candidateStrategies
    .map((strategy) => {
      const artifactValueScore = scoreTutoringStrategyWithArtifact(strategy, DEFAULT_TUTORING_POLICY_ARTIFACT);
      const worldModelTrace = scoreWorldModelCandidate(worldModelTransitions.get(strategy.id), config.worldModelRiskPenalty);
      const artifactBlend = round3(strategy.score * config.blendWeight + artifactValueScore * (1 - config.blendWeight));
      const blendedScore = round3(
        artifactBlend * (1 - config.worldModelBlendWeight) + worldModelTrace.worldModelScore * config.worldModelBlendWeight
      );
      return {
        strategy,
        heuristicScore: strategy.score,
        artifactValueScore,
        blendedScore,
        worldModelScore: worldModelTrace.worldModelScore,
        worldModelProjectedRecoveryProbability: worldModelTrace.projectedRecoveryProbability,
        worldModelProjectedStabilityGain: worldModelTrace.projectedStabilityGain,
        worldModelProjectedConfidenceDelta: worldModelTrace.projectedConfidenceDelta,
        worldModelProjectedLowConfidenceRisk: worldModelTrace.projectedLowConfidenceRisk,
        muonHelperScore: null,
        finalScore: blendedScore,
        helperSupport: 0,
      };
    })
    .sort((left, right) => right.blendedScore - left.blendedScore || right.heuristicScore - left.heuristicScore);

  const adaptiveSelected = candidateScores[0]?.strategy || heuristicSelected;
  const predictedUplift = round3((candidateScores[0]?.blendedScore || 0) - (candidateScores.find((candidate) => candidate.strategy.id === heuristicSelected.id)?.blendedScore || 0));
  const disagreement = adaptiveSelected.id !== heuristicSelected.id;
  const abstained = disagreement && predictedUplift < config.abstainThreshold;
  const artifactOverrideApplied = config.enabled && disagreement && !abstained;
  let effectiveSelected = artifactOverrideApplied ? adaptiveSelected : heuristicSelected;

  const muonResult = applyMuonHelperLoop({
    config: muonInput.config,
    heuristicSelectedStrategyId: heuristicSelected.id,
    baseSelectedStrategyId: effectiveSelected.id,
    weakTopicMatches: guidance.metadata.weakTopicMatches,
    misconceptionSignals: guidance.metadata.misconceptionSignals,
    outcomes: muonInput.outcomes,
    candidates: candidateScores.map((candidate) => ({
      strategy: candidate.strategy,
      baseScore: candidate.blendedScore,
    })),
  });

  candidateScores = candidateScores.map((candidate) => {
    const muonCandidate = muonResult.candidateScores.find((item) => item.strategyId === candidate.strategy.id);
    return {
      ...candidate,
      muonHelperScore: muonCandidate?.helperScore ?? null,
      finalScore: muonCandidate?.finalScore ?? candidate.blendedScore,
      helperSupport: muonCandidate?.support ?? 0,
    };
  }).sort((left, right) => right.finalScore - left.finalScore || right.blendedScore - left.blendedScore);

  const muonOverrideApplied = !!muonResult.telemetry?.overrideApplied;
  if (muonOverrideApplied) {
    effectiveSelected = candidateScores.find((candidate) => candidate.strategy.id === muonResult.selectedStrategyId)?.strategy || effectiveSelected;
  }

  const overrideApplied = artifactOverrideApplied || muonOverrideApplied;
  const updatedStrategies = guidance.metadata.candidateStrategies.map((strategy) => ({
    ...strategy,
    selected: strategy.id === effectiveSelected.id,
  }));
  const telemetry: AdaptiveTutoringTelemetry | null = config.shadowEnabled || config.enabled || !!muonResult.telemetry
    ? {
        mode: config.enabled ? "active" : "shadow",
        policyVersion: config.policyVersion,
        selectedPolicyLabel: config.selectedPolicyLabel,
        scorerKind: config.scorerKind,
        blendWeight: round3(config.blendWeight),
        abstainThreshold: round3(config.abstainThreshold),
        worldModelBlendWeight: round3(config.worldModelBlendWeight),
        worldModelRiskPenalty: round3(config.worldModelRiskPenalty),
        heuristicSelectedStrategyId: heuristicSelected.id,
        adaptiveSelectedStrategyId: adaptiveSelected.id,
        effectiveSelectedStrategyId: effectiveSelected.id,
        disagreement,
        abstained,
        overrideApplied,
        artifactOverrideApplied,
        muonOverrideApplied,
        muonHelperLoop: muonResult.telemetry,
        candidateScores: candidateScores.map((candidate) => ({
          strategyId: candidate.strategy.id,
          heuristicScore: round3(candidate.heuristicScore),
          artifactValueScore: round3(candidate.artifactValueScore),
          blendedScore: round3(candidate.blendedScore),
          worldModelScore: typeof candidate.worldModelScore === "number" ? round3(candidate.worldModelScore) : null,
          worldModelProjectedRecoveryProbability:
            typeof candidate.worldModelProjectedRecoveryProbability === "number"
              ? round3(candidate.worldModelProjectedRecoveryProbability)
              : null,
          worldModelProjectedStabilityGain:
            typeof candidate.worldModelProjectedStabilityGain === "number"
              ? round3(candidate.worldModelProjectedStabilityGain)
              : null,
          worldModelProjectedConfidenceDelta:
            typeof candidate.worldModelProjectedConfidenceDelta === "number"
              ? round3(candidate.worldModelProjectedConfidenceDelta)
              : null,
          worldModelProjectedLowConfidenceRisk:
            typeof candidate.worldModelProjectedLowConfidenceRisk === "number"
              ? round3(candidate.worldModelProjectedLowConfidenceRisk)
              : null,
          muonHelperScore: typeof candidate.muonHelperScore === "number" ? round3(candidate.muonHelperScore) : null,
          finalScore: round3(candidate.finalScore),
          helperSupport: candidate.helperSupport,
          heuristicSelected: candidate.strategy.id === heuristicSelected.id,
          adaptiveSelected: candidate.strategy.id === adaptiveSelected.id,
          muonHelperSelected: !!muonResult.telemetry?.candidateScores.find((item) => item.strategyId === candidate.strategy.id)?.helperSelected,
        })),
      }
    : null;

  if (!overrideApplied) {
    return {
      guidance: {
        ...guidance,
        metadata: {
          ...guidance.metadata,
          candidateStrategies: updatedStrategies,
          selectedStrategy: updatedStrategies.find((strategy) => strategy.id === heuristicSelected.id) || heuristicSelected,
        },
      },
      telemetry,
    };
  }

  return {
    guidance: {
      response: {
        ...guidance.response,
        final_answer: effectiveSelected.hint,
        reasoning: muonOverrideApplied
          ? `Applied the bounded ${muonInput.config.selectedPolicyLabel} Muon helper loop over ${updatedStrategies.length} tutoring candidates after the frozen adaptive artifact pass, while keeping abstention guards active.`
          : `Applied the ${config.selectedPolicyLabel} adaptive policy artifact over ${updatedStrategies.length} tutoring candidates while preserving the heuristic tutoring controller as the default path.`,
        confidence: effectiveSelected.confidence,
        trajectory_score: effectiveSelected.score,
      },
      metadata: {
        ...guidance.metadata,
        candidateStrategies: updatedStrategies,
        selectedStrategy: updatedStrategies.find((strategy) => strategy.id === effectiveSelected.id) || effectiveSelected,
      },
    },
    telemetry,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function scoreWorldModelCandidate(
  transition: ReturnType<typeof buildTutoringWorldModel>["candidateTransitions"][number] | undefined,
  worldModelRiskPenalty: number
) {
  if (!transition) {
    return {
      worldModelScore: 0,
      projectedRecoveryProbability: null,
      projectedStabilityGain: null,
      projectedConfidenceDelta: null,
      projectedLowConfidenceRisk: null,
    };
  }

  const normalizedConfidenceDelta = clamp((transition.projectedConfidenceDelta + 0.2) / 0.5, 0, 1);
  const worldModelScore = round3(
    clamp(
      transition.projectedRecoveryProbability * 0.42 +
        transition.projectedStabilityGain * 0.33 +
        normalizedConfidenceDelta * 0.15 +
        (1 - transition.projectedLowConfidenceRisk) * 0.1 -
        transition.projectedLowConfidenceRisk * worldModelRiskPenalty,
      0,
      1
    )
  );

  return {
    worldModelScore,
    projectedRecoveryProbability: transition.projectedRecoveryProbability,
    projectedStabilityGain: transition.projectedStabilityGain,
    projectedConfidenceDelta: transition.projectedConfidenceDelta,
    projectedLowConfidenceRisk: transition.projectedLowConfidenceRisk,
  };
}

async function loadMuonHelperLoopOutcomes(userId: string, limit: number): Promise<MuonHelperLoopOutcome[]> {
  const runs = await prisma.reasoningRun.findMany({
    where: {
      userId,
      mode: "study_recovery",
      origin: "study_carousel",
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      confidence: true,
      trajectoryScore: true,
      metadata: true,
      createdAt: true,
    },
  });

  return runs
    .map((run) => {
      const metadata = asRecord(run.metadata);
      const selectedStrategy = asRecord(metadata?.selectedStrategy);
      const worldModel = asRecord(metadata?.worldModel);
      const selectedTransition = asRecord(worldModel?.selectedTransition);
      const reward = clamp(
        toFiniteNumber(metadata?.postReviewConfidence) * 0.45 +
          toFiniteNumber(run.trajectoryScore) * 0.25 +
          toFiniteNumber(run.confidence) * 0.15 +
          toFiniteNumber(selectedTransition?.projectedRecoveryProbability) * 0.1 +
          toFiniteNumber(selectedTransition?.projectedStabilityGain) * 0.05,
        0,
        1
      );

      const strategyType = toTutoringStrategyType(selectedStrategy?.strategyType);
      const strategyMode = toTutoringStrategyMode(selectedStrategy?.strategyMode);
      const strategyId = toStringValue(selectedStrategy?.id);
      if (!strategyId || !strategyType) return null;

      return {
        strategyId,
        strategyType,
        strategyMode,
        weakTopicMatches: toStringArray(metadata?.weakTopicMatches),
        misconceptionSignals: toStringArray(metadata?.misconceptionSignals),
        reward: round3(reward),
        confidence: round3(toFiniteNumber(run.confidence)),
        trajectoryScore: round3(toFiniteNumber(run.trajectoryScore)),
        createdAt: run.createdAt.toISOString(),
      } satisfies MuonHelperLoopOutcome;
    })
    .filter((item): item is MuonHelperLoopOutcome => Boolean(item));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toTutoringStrategyType(value: unknown): TutoringGuidanceResult["metadata"]["selectedStrategy"]["strategyType"] | null {
  return value === "conceptual" || value === "diagnostic" || value === "scaffolded" ? value : null;
}

function toTutoringStrategyMode(value: unknown): TutoringGuidanceResult["metadata"]["selectedStrategy"]["strategyMode"] | null {
  return value === "exploration" || value === "repair" || value === "reinforcement" ? value : null;
}

function createTraceId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random()}`;
}