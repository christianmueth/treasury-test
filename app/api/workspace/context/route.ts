import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma, safeUpsertUser } from "@/lib/db";
import { sanitizeWorkspaceContext } from "@/lib/workspaceContext";
import {
  getLatestPersistedWorkspaceContext,
  persistWorkspaceContextSnapshot,
} from "@/lib/workspaceContextPersistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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
      return NextResponse.json({ ok: true, context: null, savedAt: null });
    }

    const latest = await getLatestPersistedWorkspaceContext(user.id);
    return NextResponse.json({ ok: true, context: latest.context, savedAt: latest.savedAt });
  } catch (error) {
    console.error("[WorkspaceContext] GET failed:", error);
    return NextResponse.json({ ok: true, context: null, savedAt: null });
  }
}

export async function POST(req: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as { context?: unknown; deckId?: string | null };
    const context = sanitizeWorkspaceContext(body.context);
    if (!context) {
      return NextResponse.json({ ok: false, error: "A valid workspace context is required." }, { status: 400 });
    }

    const user = await safeUpsertUser(clerkUserId, { id: true });

    if (!user) {
      return NextResponse.json({
        ok: true,
        context,
        savedAt: null,
        reused: false,
        degraded: true,
      });
    }

    const saved = await persistWorkspaceContextSnapshot({
      userId: user.id,
      deckId: body.deckId || null,
      context,
    });

    return NextResponse.json({
      ok: true,
      context: saved.context,
      savedAt: saved.savedAt,
      reused: saved.reused,
    });
  } catch (error) {
    console.error("[WorkspaceContext] POST failed:", error);
    return NextResponse.json({ ok: false, error: "Failed to save workspace context." }, { status: 500 });
  }
}