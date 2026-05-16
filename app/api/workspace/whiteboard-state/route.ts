import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { prisma, safeUpsertUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function internalErrorResponse(message: string, error: unknown) {
  console.error(message, error);
  return NextResponse.json({ ok: false, error: "Whiteboard state is unavailable right now." }, { status: 500 });
}

type StrokePoint = { x: number; y: number };
type Stroke = { id: string; color: string; width: number; points: StrokePoint[] };
type BoardRectangle = { id: string; kind: "rectangle"; x: number; y: number; width: number; height: number; color: string };
type BoardArrow = { id: string; kind: "arrow"; start: StrokePoint; end: StrokePoint; color: string };
type BoardShape = BoardRectangle | BoardArrow;
type BoardNote = { id: string; x: number; y: number; width: number; height: number; text: string; color: string };
type ToolMode = "select" | "draw" | "pan" | "rectangle" | "arrow" | "note";

type PersistedWhiteboardState = {
  strokes: Stroke[];
  shapes: BoardShape[];
  notes: BoardNote[];
  annotations: string[];
  workspaceGoal: string;
  toolMode: ToolMode;
  viewportScale: number;
  viewportOffset: { x: number; y: number };
};

type WhiteboardStateRequest = {
  snapshot?: PersistedWhiteboardState;
  boardId?: string;
  boardName?: string;
};

type WhiteboardRenameRequest = {
  boardId?: string;
  boardName?: string;
};

type StoredBoardMetadata = {
  boardId?: unknown;
  boardName?: unknown;
  snapshot?: unknown;
};

export async function GET(req: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json({ ok: true, boards: [], snapshot: null, savedAt: null, boardId: null, boardName: null });
    }

    const requestUrl = new URL(req.url);
    const requestedBoardId = cleanString(requestUrl.searchParams.get("boardId"));
    const runs = await prisma.reasoningRun.findMany({
      where: { userId: user.id, mode: "workspace_whiteboard_state", origin: "workspace_whiteboard" },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, metadata: true },
      take: 200,
    });

    const latestByBoard = new Map<string, { boardId: string; boardName: string; snapshot: PersistedWhiteboardState | null; savedAt: string }>();
    for (const run of runs) {
      const metadata = (run.metadata as StoredBoardMetadata | null) ?? null;
      const boardId = cleanString(metadata?.boardId) || `board-${run.id}`;
      if (latestByBoard.has(boardId)) continue;
      latestByBoard.set(boardId, {
        boardId,
        boardName: cleanString(metadata?.boardName) || "Untitled board",
        snapshot: sanitizeSnapshot(metadata?.snapshot),
        savedAt: run.createdAt.toISOString(),
      });
    }

    const boards = Array.from(latestByBoard.values()).map((board) => ({
      boardId: board.boardId,
      boardName: board.boardName,
      savedAt: board.savedAt,
    }));

    const selected = requestedBoardId ? latestByBoard.get(requestedBoardId) ?? null : boards.length ? latestByBoard.get(boards[0].boardId) ?? null : null;

    return NextResponse.json({
      ok: true,
      boards,
      snapshot: selected?.snapshot ?? null,
      savedAt: selected?.savedAt ?? null,
      boardId: selected?.boardId ?? null,
      boardName: selected?.boardName ?? null,
    });
  } catch (error) {
    console.error("[WorkspaceWhiteboard] GET failed:", error);
    return NextResponse.json({
      ok: true,
      boards: [],
      snapshot: null,
      savedAt: null,
      boardId: null,
      boardName: null,
      degraded: true,
    });
  }
}

export async function POST(req: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as WhiteboardStateRequest;
    const snapshot = sanitizeSnapshot(body.snapshot);
    if (!snapshot) {
      return NextResponse.json({ ok: false, error: "A valid whiteboard snapshot is required." }, { status: 400 });
    }

    const user = await safeUpsertUser(clerkUserId, { id: true });

    const boardId = cleanString(body.boardId) || `board-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const boardName = (cleanString(body.boardName) || snapshot.workspaceGoal || "Untitled board").slice(0, 120);

    if (!user) {
      return NextResponse.json({ ok: true, boardId, boardName, savedAt: null, degraded: true });
    }

    const saved = await prisma.reasoningRun.create({
      data: {
        userId: user.id,
        mode: "workspace_whiteboard_state",
        origin: "workspace_whiteboard",
        title: boardName,
        metadata: {
          boardId,
          boardName,
          snapshot,
        } as Prisma.InputJsonValue,
      },
      select: { createdAt: true },
    });

    return NextResponse.json({ ok: true, boardId, boardName, savedAt: saved.createdAt.toISOString() });
  } catch (error) {
    return internalErrorResponse("[WorkspaceWhiteboard] POST failed:", error);
  }
}

export async function DELETE(req: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as { boardId?: string };
    const requestedBoardId = cleanString(body.boardId);
    if (!requestedBoardId) {
      return NextResponse.json({ ok: false, error: "Board id is required." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    if (!user) {
      return NextResponse.json({ ok: true, deletedCount: 0 });
    }

    const runs = await prisma.reasoningRun.findMany({
      where: { userId: user.id, mode: "workspace_whiteboard_state", origin: "workspace_whiteboard" },
      select: { id: true, metadata: true },
      take: 500,
    });

    const matchingIds = runs
      .filter((run) => cleanString((run.metadata as StoredBoardMetadata | null)?.boardId) === requestedBoardId)
      .map((run) => run.id);

    if (!matchingIds.length) {
      return NextResponse.json({ ok: true, deletedCount: 0 });
    }

    const result = await prisma.reasoningRun.deleteMany({
      where: { id: { in: matchingIds } },
    });

    return NextResponse.json({ ok: true, deletedCount: result.count });
  } catch (error) {
    return internalErrorResponse("[WorkspaceWhiteboard] DELETE failed:", error);
  }
}

export async function PATCH(req: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as WhiteboardRenameRequest;
    const requestedBoardId = cleanString(body.boardId);
    const requestedBoardName = cleanString(body.boardName).slice(0, 120);

    if (!requestedBoardId) {
      return NextResponse.json({ ok: false, error: "Board id is required." }, { status: 400 });
    }

    if (!requestedBoardName) {
      return NextResponse.json({ ok: false, error: "Board name is required." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    if (!user) {
      return NextResponse.json({ ok: false, error: "Board not found." }, { status: 404 });
    }

    const runs = await prisma.reasoningRun.findMany({
      where: { userId: user.id, mode: "workspace_whiteboard_state", origin: "workspace_whiteboard" },
      select: { id: true, metadata: true },
      take: 500,
    });

    const matchingRuns = runs.filter((run) => cleanString((run.metadata as StoredBoardMetadata | null)?.boardId) === requestedBoardId);
    if (!matchingRuns.length) {
      return NextResponse.json({ ok: false, error: "Board not found." }, { status: 404 });
    }

    await Promise.all(matchingRuns.map((run) => {
      const metadata = ((run.metadata as StoredBoardMetadata | null) ?? {}) as StoredBoardMetadata;
      return prisma.reasoningRun.update({
        where: { id: run.id },
        data: {
          title: requestedBoardName,
          metadata: {
            ...metadata,
            boardId: requestedBoardId,
            boardName: requestedBoardName,
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
    }));

    return NextResponse.json({ ok: true, boardId: requestedBoardId, boardName: requestedBoardName });
  } catch (error) {
    return internalErrorResponse("[WorkspaceWhiteboard] PATCH failed:", error);
  }
}

function sanitizeSnapshot(value: unknown): PersistedWhiteboardState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return {
    strokes: Array.isArray(candidate.strokes) ? candidate.strokes.map(sanitizeStroke).filter(Boolean) as Stroke[] : [],
    shapes: Array.isArray(candidate.shapes) ? candidate.shapes.map(sanitizeShape).filter(Boolean) as BoardShape[] : [],
    notes: Array.isArray(candidate.notes) ? candidate.notes.map(sanitizeNote).filter(Boolean) as BoardNote[] : [],
    annotations: Array.isArray(candidate.annotations) ? candidate.annotations.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    workspaceGoal: typeof candidate.workspaceGoal === "string" ? candidate.workspaceGoal.slice(0, 4000) : "",
    toolMode: isToolMode(candidate.toolMode) ? candidate.toolMode : "select",
    viewportScale: clamp(Number(candidate.viewportScale) || 1, 0.6, 2.5),
    viewportOffset: {
      x: Number((candidate.viewportOffset as Record<string, unknown> | undefined)?.x) || 0,
      y: Number((candidate.viewportOffset as Record<string, unknown> | undefined)?.y) || 0,
    },
  };
}

function sanitizeStroke(value: unknown): Stroke | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return {
    id: cleanString(candidate.id) || `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    color: typeof candidate.color === "string" ? candidate.color : "#0f172a",
    width: clamp(Number(candidate.width) || 3, 1, 20),
    points: Array.isArray(candidate.points) ? candidate.points.map(sanitizePoint).filter(Boolean) as StrokePoint[] : [],
  };
}

function sanitizeShape(value: unknown): BoardShape | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "rectangle") {
    return {
      id: String(candidate.id || `rect-${Date.now()}`),
      kind: "rectangle",
      x: clamp(Number(candidate.x) || 0, 0, 960),
      y: clamp(Number(candidate.y) || 0, 0, 560),
      width: clamp(Number(candidate.width) || 60, 40, 960),
      height: clamp(Number(candidate.height) || 50, 40, 560),
      color: typeof candidate.color === "string" ? candidate.color : "#0f172a",
    };
  }
  if (candidate.kind === "arrow") {
    const start = sanitizePoint(candidate.start);
    const end = sanitizePoint(candidate.end);
    if (!start || !end) return null;
    return {
      id: String(candidate.id || `arrow-${Date.now()}`),
      kind: "arrow",
      start,
      end,
      color: typeof candidate.color === "string" ? candidate.color : "#0284C7",
    };
  }
  return null;
}

function sanitizeNote(value: unknown): BoardNote | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return {
    id: String(candidate.id || `note-${Date.now()}`),
    x: clamp(Number(candidate.x) || 0, 0, 960),
    y: clamp(Number(candidate.y) || 0, 0, 560),
    width: clamp(Number(candidate.width) || 180, 120, 960),
    height: clamp(Number(candidate.height) || 120, 80, 560),
    text: typeof candidate.text === "string" ? candidate.text.slice(0, 4000) : "",
    color: typeof candidate.color === "string" ? candidate.color : "#FEF3C7",
  };
}

function sanitizePoint(value: unknown): StrokePoint | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return {
    x: clamp(Number(candidate.x) || 0, 0, 960),
    y: clamp(Number(candidate.y) || 0, 0, 560),
  };
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isToolMode(value: unknown): value is ToolMode {
  return value === "select" || value === "draw" || value === "pan" || value === "rectangle" || value === "arrow" || value === "note";
}
