"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  WORKSPACE_CONTEXT_EVENT,
  readWorkspaceContext,
  updateWorkspaceContext,
  upsertWorkspaceAsset,
  type WorkspaceContext,
} from "@/lib/workspaceContext";

async function safeJson(res: Response) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const runtimeImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<any>;

type WhiteboardAssistIntent = "clean-sketch" | "flowchart" | "relationships" | "visualize";
type ToolMode = "select" | "draw" | "erase" | "pan" | "rectangle" | "arrow" | "note";
type ExportFormat = "png" | "jpeg" | "webp" | "svg";
type ResizeHandle = "nw" | "ne" | "sw" | "se";
type BoardPresetId = "concept-map" | "timeline" | "compare-contrast";

type WhiteboardAssistSuggestion = {
  title: string;
  summary: string;
  actions: string[];
  cautions: string[];
  nodes: Array<{ id: string; label: string; x: number; y: number }>;
  connections: Array<{ from: string; to: string; label: string }>;
};

type StrokePoint = { x: number; y: number };
type Stroke = { id: string; color: string; width: number; points: StrokePoint[] };
type PdfViewport = { width: number; height: number };
type PdfPageLike = {
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }) => { promise: Promise<void> };
};
type PdfDocumentLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
  destroy?: () => void;
};

type BoardRectangle = {
  id: string;
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
};

type BoardArrow = {
  id: string;
  kind: "arrow";
  start: StrokePoint;
  end: StrokePoint;
  color: string;
};

type BoardShape = BoardRectangle | BoardArrow;

type BoardNote = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
};

type BoardImage = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
  name: string;
};

type DraftShape = {
  kind: "rectangle" | "arrow";
  start: StrokePoint;
  current: StrokePoint;
};

type PanState = {
  pointerId: number;
  startClient: { x: number; y: number };
  startOffset: { x: number; y: number };
};

type PinchGestureState = {
  pointerIds: [number, number];
  startDistance: number;
  anchorBoardPoint: StrokePoint;
};

type SelectionDragState = {
  pointerId: number;
  startClient: { x: number; y: number };
  strokeOrigins: Array<{ id: string; points: StrokePoint[] }>;
  noteOrigins: Array<{ id: string; x: number; y: number }>;
  imageOrigins: Array<{ id: string; x: number; y: number }>;
  shapeOrigins: Array<{ id: string; kind: BoardShape["kind"]; x?: number; y?: number; start?: StrokePoint; end?: StrokePoint }>;
};

type ResizeState =
  | {
      pointerId: number;
      kind: "note";
      noteId: string;
      handle: ResizeHandle;
      origin: { x: number; y: number; width: number; height: number };
      startClient: { x: number; y: number };
    }
  | {
      pointerId: number;
      kind: "rectangle";
      shapeId: string;
      handle: ResizeHandle;
      origin: { x: number; y: number; width: number; height: number };
      startClient: { x: number; y: number };
    }
  | {
      pointerId: number;
      kind: "image";
      imageId: string;
      handle: ResizeHandle;
      origin: { x: number; y: number; width: number; height: number };
      startClient: { x: number; y: number };
    }
  | {
      pointerId: number;
      kind: "arrow-start" | "arrow-end";
      shapeId: string;
      startClient: { x: number; y: number };
      originStart: StrokePoint;
      originEnd: StrokePoint;
    };

type SelectionBox = {
  pointerId: number;
  start: StrokePoint;
  current: StrokePoint;
  append: boolean;
};

type PersistedWhiteboardState = {
  strokes: Stroke[];
  shapes: BoardShape[];
  notes: BoardNote[];
  images: BoardImage[];
  annotations: string[];
  workspaceGoal: string;
  toolMode: ToolMode;
  viewportScale: number;
  viewportOffset: { x: number; y: number };
};

type RemoteBoardSummary = {
  boardId: string;
  boardName: string;
  savedAt: string;
};

type WhiteboardStateResponse = {
  ok: boolean;
  boards?: RemoteBoardSummary[];
  snapshot?: PersistedWhiteboardState | null;
  savedAt?: string | null;
  boardId?: string | null;
  boardName?: string | null;
  deletedCount?: number;
  error?: string;
};

const CANVAS_WIDTH = 2400;
const CANVAS_HEIGHT = 1600;
const WHITEBOARD_STORAGE_KEY = "mate-e:workspace-whiteboard-v4";
const LEGACY_WHITEBOARD_STORAGE_KEY = "quickstud:workspace-whiteboard-v4";
const DEFAULT_NOTE_COLOR = "#FEF3C7";
const COLOR_SWATCHES = ["#0f172a", "#0284c7", "#0f766e", "#7c3aed", "#dc2626", "#d97706"];
const NOTE_COLOR_SWATCHES = ["#FEF3C7", "#DBEAFE", "#DCFCE7", "#FCE7F3", "#FDE68A", "#E9D5FF"];
const DEFAULT_NOTE_WIDTH = 180;
const DEFAULT_NOTE_HEIGHT = 120;
const MIN_NOTE_WIDTH = 140;
const MIN_NOTE_HEIGHT = 90;
const MIN_RECT_WIDTH = 8;
const MIN_RECT_HEIGHT = 8;
const DEFAULT_BOARD_IMAGE_WIDTH = 320;
const DEFAULT_BOARD_IMAGE_HEIGHT = 220;
const MIN_BOARD_IMAGE_WIDTH = 96;
const MIN_BOARD_IMAGE_HEIGHT = 72;
const HISTORY_LIMIT = 40;

const BOARD_PRESETS: Array<{
  id: BoardPresetId;
  label: string;
  description: string;
  create: () => Pick<PersistedWhiteboardState, "notes" | "shapes" | "annotations" | "workspaceGoal">;
}> = [
  {
    id: "concept-map",
    label: "Concept map",
    description: "Central concept with surrounding supporting ideas.",
    create: () => ({
      workspaceGoal: "Explain the central idea and its supporting concepts.",
      annotations: ["Use the center note for the main topic and the outer notes for key ideas."],
      notes: [
        createNote("Main concept", 380, 210, "#DBEAFE", 200, 124),
        createNote("Key idea 1", 120, 90, DEFAULT_NOTE_COLOR),
        createNote("Key idea 2", 650, 90, DEFAULT_NOTE_COLOR),
        createNote("Evidence", 120, 360, "#FCE7F3"),
        createNote("Example", 650, 360, "#DCFCE7"),
      ],
      shapes: [
        createArrow({ x: 300, y: 150 }, { x: 390, y: 230 }),
        createArrow({ x: 660, y: 150 }, { x: 570, y: 230 }),
        createArrow({ x: 300, y: 410 }, { x: 390, y: 330 }),
        createArrow({ x: 660, y: 410 }, { x: 570, y: 330 }),
      ],
    }),
  },
  {
    id: "timeline",
    label: "Timeline",
    description: "Lay out events or steps across a sequence.",
    create: () => ({
      workspaceGoal: "Organize the sequence from first step to final outcome.",
      annotations: ["Move each note as needed and add arrows for branching."],
      notes: [
        createNote("Start", 40, 200, "#DBEAFE", 150, 104),
        createNote("Step 2", 250, 200, DEFAULT_NOTE_COLOR, 150, 104),
        createNote("Step 3", 460, 200, DEFAULT_NOTE_COLOR, 150, 104),
        createNote("Result", 670, 200, "#DCFCE7", 150, 104),
      ],
      shapes: [
        createArrow({ x: 190, y: 252 }, { x: 250, y: 252 }),
        createArrow({ x: 400, y: 252 }, { x: 460, y: 252 }),
        createArrow({ x: 610, y: 252 }, { x: 670, y: 252 }),
      ],
    }),
  },
  {
    id: "compare-contrast",
    label: "Compare/contrast",
    description: "Two columns with a shared bridge between them.",
    create: () => ({
      workspaceGoal: "Compare two ideas and surface the most important differences.",
      annotations: ["Put shared ground in the center and contrasting details on each side."],
      notes: [
        createNote("Idea A", 70, 80, "#FCE7F3", 220, 120),
        createNote("Idea B", 670, 80, "#DBEAFE", 220, 120),
        createNote("Shared criteria", 350, 210, DEFAULT_NOTE_COLOR, 260, 124),
        createNote("Distinct features", 70, 380, "#FDE68A", 220, 120),
        createNote("Distinct features", 670, 380, "#BFDBFE", 220, 120),
      ],
      shapes: [
        createArrow({ x: 290, y: 140 }, { x: 350, y: 260 }),
        createArrow({ x: 670, y: 140 }, { x: 610, y: 260 }),
        createArrow({ x: 290, y: 440 }, { x: 350, y: 300 }),
        createArrow({ x: 670, y: 440 }, { x: 610, y: 300 }),
      ],
    }),
  },
];

export default function WorkspaceWhiteboard() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boardViewportRef = useRef<HTMLDivElement | null>(null);
  const drawingStrokeRef = useRef<Stroke | null>(null);
  const activeCanvasPointerIdRef = useRef<number | null>(null);
  const activeTouchPointsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchGestureRef = useRef<PinchGestureState | null>(null);
  const pdfDocumentRef = useRef<PdfDocumentLike | null>(null);
  const sourceObjectUrlRef = useRef<string | null>(null);
  const historyTimeoutRef = useRef<number | null>(null);
  const processedCommandRef = useRef<string | null>(null);
  const autoCollapsedForCompactRef = useRef(false);
  const undoStackRef = useRef<PersistedWhiteboardState[]>([]);
  const redoStackRef = useRef<PersistedWhiteboardState[]>([]);
  const historyBaselineRef = useRef<PersistedWhiteboardState | null>(null);
  const historySuspendRef = useRef(false);

  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [penColor, setPenColor] = useState("#0f172a");
  const [noteColor, setNoteColor] = useState(DEFAULT_NOTE_COLOR);
  const [penWidth, setPenWidth] = useState(3);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [shapes, setShapes] = useState<BoardShape[]>([]);
  const [notes, setNotes] = useState<BoardNote[]>([]);
  const [boardImages, setBoardImages] = useState<BoardImage[]>([]);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [annotations, setAnnotations] = useState<string[]>([]);
  const [workspaceGoal, setWorkspaceGoal] = useState("");
  const [sourceAttachmentName, setSourceAttachmentName] = useState<string | null>(null);
  const [sourceAttachmentUrl, setSourceAttachmentUrl] = useState<string | null>(null);
  const [sourceOverlayKind, setSourceOverlayKind] = useState<"image" | "pdf" | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [pdfCurrentPage, setPdfCurrentPage] = useState(1);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [assistLoading, setAssistLoading] = useState<WhiteboardAssistIntent | null>(null);
  const [imagePromptLoading, setImagePromptLoading] = useState(false);
  const [assistSuggestion, setAssistSuggestion] = useState<WhiteboardAssistSuggestion | null>(null);
  const [showOverlayGuide, setShowOverlayGuide] = useState(true);
  const [draftShape, setDraftShape] = useState<DraftShape | null>(null);
  const [panState, setPanState] = useState<PanState | null>(null);
  const [selectionDragState, setSelectionDragState] = useState<SelectionDragState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [viewportScale, setViewportScale] = useState(1);
  const [viewportOffset, setViewportOffset] = useState({ x: 0, y: 0 });
  const [selectedStrokeIds, setSelectedStrokeIds] = useState<string[]>([]);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([]);
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [hasHydratedLocalState, setHasHydratedLocalState] = useState(false);
  const [hasLocalSnapshot, setHasLocalSnapshot] = useState(false);
  const [remoteSyncLoading, setRemoteSyncLoading] = useState(false);
  const [hasResolvedInitialRemoteState, setHasResolvedInitialRemoteState] = useState(false);
  const [remoteSyncSaving, setRemoteSyncSaving] = useState(false);
  const [remoteSavedAt, setRemoteSavedAt] = useState<string | null>(null);
  const [remoteBoards, setRemoteBoards] = useState<RemoteBoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardName, setBoardName] = useState("Untitled board");
  const [renamingBoardId, setRenamingBoardId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [showControlsPanel, setShowControlsPanel] = useState(true);
  const [showCopilot, setShowCopilot] = useState(true);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceContext>(() => readWorkspaceContext());

  function getBoardViewportCenter() {
    const viewport = boardViewportRef.current;
    if (!viewport) {
      return { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    }
    const rect = viewport.getBoundingClientRect();
    return {
      x: clamp((rect.width / 2 - viewportOffset.x) / viewportScale, 0, CANVAS_WIDTH),
      y: clamp((rect.height / 2 - viewportOffset.y) / viewportScale, 0, CANVAS_HEIGHT),
    };
  }

  function cancelTouchSinglePointerInteraction() {
    if (drawingStrokeRef.current) {
      const strokeId = drawingStrokeRef.current.id;
      setStrokes((current) => current.filter((stroke) => stroke.id !== strokeId));
    }
    drawingStrokeRef.current = null;
    activeCanvasPointerIdRef.current = null;
    setDraftShape(null);
    setSelectionBox(null);
    setSelectionDragState(null);
    setResizeState(null);
    setPanState(null);
  }

  function beginPinchGesture() {
    const touchEntries = [...activeTouchPointsRef.current.entries()].slice(0, 2);
    const viewport = boardViewportRef.current;
    if (touchEntries.length < 2 || !viewport) return;

    const [[firstId, firstPoint], [secondId, secondPoint]] = touchEntries;
    const rect = viewport.getBoundingClientRect();
    const midpoint = {
      x: (firstPoint.x + secondPoint.x) / 2,
      y: (firstPoint.y + secondPoint.y) / 2,
    };
    const distance = Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y);
    if (distance < 12) return;

    cancelTouchSinglePointerInteraction();
    pinchGestureRef.current = {
      pointerIds: [firstId, secondId],
      startDistance: distance,
      anchorBoardPoint: {
        x: clamp((midpoint.x - rect.left - viewportOffset.x) / viewportScale, 0, CANVAS_WIDTH),
        y: clamp((midpoint.y - rect.top - viewportOffset.y) / viewportScale, 0, CANVAS_HEIGHT),
      },
    };
  }

  function updatePinchGesture() {
    const gesture = pinchGestureRef.current;
    const viewport = boardViewportRef.current;
    if (!gesture || !viewport) return false;

    const [firstId, secondId] = gesture.pointerIds;
    const firstPoint = activeTouchPointsRef.current.get(firstId);
    const secondPoint = activeTouchPointsRef.current.get(secondId);
    if (!firstPoint || !secondPoint) return false;

    const rect = viewport.getBoundingClientRect();
    const midpoint = {
      x: (firstPoint.x + secondPoint.x) / 2,
      y: (firstPoint.y + secondPoint.y) / 2,
    };
    const distance = Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y);
    const nextScale = clamp(round2(viewportScale * (distance / gesture.startDistance)), 0.6, 2.5);

    setViewportScale(nextScale);
    setViewportOffset({
      x: midpoint.x - rect.left - gesture.anchorBoardPoint.x * nextScale,
      y: midpoint.y - rect.top - gesture.anchorBoardPoint.y * nextScale,
    });

    pinchGestureRef.current = {
      ...gesture,
      startDistance: distance,
    };
    return true;
  }

  function beginTouchPan(pointerId: number, clientPoint: { x: number; y: number }) {
    setPanState({
      pointerId,
      startClient: clientPoint,
      startOffset: viewportOffset,
    });
  }

  function resumeTouchPanAfterPinch() {
    const remainingTouch = activeTouchPointsRef.current.entries().next();
    if (remainingTouch.done) return false;

    const [pointerId, point] = remainingTouch.value;
    beginTouchPan(pointerId, point);
    return true;
  }

  function currentSnapshot(): PersistedWhiteboardState {
    return {
      strokes,
      shapes,
      notes,
      images: boardImages,
      annotations,
      workspaceGoal,
      toolMode,
      viewportScale,
      viewportOffset,
    };
  }

  function syncHistoryFlags() {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }

  function clearSelection() {
    setSelectedStrokeIds([]);
    setSelectedNoteIds([]);
    setSelectedShapeIds([]);
    setSelectedImageIds([]);
  }

  function applySnapshot(snapshot: PersistedWhiteboardState, options?: { preserveTool?: boolean; clearSelection?: boolean }) {
    setStrokes(Array.isArray(snapshot.strokes) ? snapshot.strokes : []);
    setShapes(Array.isArray(snapshot.shapes) ? snapshot.shapes : []);
    setNotes(Array.isArray(snapshot.notes) ? snapshot.notes : []);
    setBoardImages(Array.isArray(snapshot.images) ? snapshot.images : []);
    setAnnotations(Array.isArray(snapshot.annotations) ? snapshot.annotations.slice(0, 8) : []);
    setWorkspaceGoal(typeof snapshot.workspaceGoal === "string" ? snapshot.workspaceGoal : "");
    if (!options?.preserveTool) {
      setToolMode(isToolMode(snapshot.toolMode) ? snapshot.toolMode : "select");
    }
    setViewportScale(clamp(Number(snapshot.viewportScale) || 1, 0.6, 2.5));
    setViewportOffset({
      x: Number(snapshot.viewportOffset?.x) || 0,
      y: Number(snapshot.viewportOffset?.y) || 0,
    });
    if (options?.clearSelection !== false) {
      clearSelection();
    }
  }

  function setHistoryBaseline(snapshot: PersistedWhiteboardState) {
    historyBaselineRef.current = cloneSnapshot(snapshot);
  }

  function restoreSnapshot(snapshot: PersistedWhiteboardState) {
    historySuspendRef.current = true;
    applySnapshot(snapshot);
    setHistoryBaseline(snapshot);
    window.setTimeout(() => {
      historySuspendRef.current = false;
    }, 0);
  }

  function createNewBoard() {
    historySuspendRef.current = true;
    setStrokes([]);
    setShapes([]);
    setNotes([]);
    setBoardImages([]);
    setAnnotations([]);
    setAnnotationDraft("");
    setWorkspaceGoal("");
    setAssistSuggestion(null);
    setShowOverlayGuide(true);
    setToolMode("select");
    setViewportScale(1);
    setViewportOffset({ x: 0, y: 0 });
    clearSelection();
    setActiveBoardId(null);
    setBoardName("Untitled board");
    setRemoteSavedAt(null);
    undoStackRef.current = [];
    redoStackRef.current = [];
    syncHistoryFlags();
    const emptySnapshot = createEmptySnapshot();
    setHistoryBaseline(emptySnapshot);
    window.setTimeout(() => {
      historySuspendRef.current = false;
    }, 0);
  }

  useEffect(() => {
    function syncCompactViewport() {
      const compact = window.innerWidth < 1024;
      setIsCompactViewport(compact);
      if (compact && !autoCollapsedForCompactRef.current) {
        setShowControlsPanel(false);
        setShowCopilot(false);
        autoCollapsedForCompactRef.current = true;
      }
    }

    syncCompactViewport();
    window.addEventListener("resize", syncCompactViewport);
    return () => {
      window.removeEventListener("resize", syncCompactViewport);
    };
  }, []);

  useEffect(() => {
    const raw =
      window.localStorage.getItem(WHITEBOARD_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_WHITEBOARD_STORAGE_KEY);
    if (!raw) {
      setHistoryBaseline(createEmptySnapshot());
      setHasHydratedLocalState(true);
      return;
    }

    try {
      const saved = JSON.parse(raw) as Partial<PersistedWhiteboardState>;
      const snapshot = sanitizePersistedState(saved);
      applySnapshot(snapshot);
      setHistoryBaseline(snapshot);
      setHasLocalSnapshot(hasMeaningfulBoardContent(snapshot));
    } catch {
      window.localStorage.removeItem(WHITEBOARD_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_WHITEBOARD_STORAGE_KEY);
      setHistoryBaseline(createEmptySnapshot());
    } finally {
      setHasHydratedLocalState(true);
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedLocalState) return;
    const snapshot = currentSnapshot();
    window.localStorage.setItem(WHITEBOARD_STORAGE_KEY, JSON.stringify(snapshot));
    window.localStorage.setItem(LEGACY_WHITEBOARD_STORAGE_KEY, JSON.stringify(snapshot));
    setHasLocalSnapshot(hasMeaningfulBoardContent(snapshot));
  }, [annotations, boardImages, hasHydratedLocalState, notes, shapes, strokes, toolMode, viewportOffset, viewportScale, workspaceGoal]);

  useEffect(() => {
    if (!hasHydratedLocalState) return;

    updateWorkspaceContext((currentContext) => {
      const nextAsset = sourceAttachmentName
        ? {
            id: `whiteboard:${sourceAttachmentName}`,
            kind: sourceOverlayKind || "file",
            name: sourceAttachmentName,
            source: "whiteboard" as const,
            updatedAt: new Date().toISOString(),
          }
        : null;

      return {
        ...currentContext,
        whiteboardReference: {
          boardId: activeBoardId,
          boardName: boardName.trim() || "Untitled board",
          workspaceGoal: workspaceGoal.trim() || null,
          noteCount: notes.length,
          shapeCount: shapes.length,
          strokeCount: strokes.length,
          selectedCount: selectedStrokeIds.length + selectedNoteIds.length + selectedShapeIds.length + selectedImageIds.length,
          annotationCount: annotations.length,
          sourceAttachmentName,
          sourceOverlayKind,
          updatedAt: new Date().toISOString(),
        },
        uploadedAssets: nextAsset ? upsertWorkspaceAsset(currentContext.uploadedAssets, nextAsset) : currentContext.uploadedAssets,
      };
    });
  }, [
    activeBoardId,
    annotations.length,
    boardName,
    boardImages.length,
    hasHydratedLocalState,
    notes.length,
    selectedImageIds.length,
    selectedNoteIds.length,
    selectedShapeIds.length,
    selectedStrokeIds.length,
    shapes.length,
    sourceAttachmentName,
    sourceOverlayKind,
    strokes.length,
    workspaceGoal,
  ]);

  useEffect(() => {
    if (!hasHydratedLocalState || historySuspendRef.current) return;
    const snapshot = currentSnapshot();
    if (!historyBaselineRef.current) {
      setHistoryBaseline(snapshot);
      return;
    }
    if (serializeSnapshot(snapshot) === serializeSnapshot(historyBaselineRef.current)) return;

    if (historyTimeoutRef.current) {
      window.clearTimeout(historyTimeoutRef.current);
    }

    historyTimeoutRef.current = window.setTimeout(() => {
      const baseline = historyBaselineRef.current;
      if (!baseline) return;
      const nextSnapshot = currentSnapshot();
      if (serializeSnapshot(nextSnapshot) === serializeSnapshot(baseline)) return;
      undoStackRef.current = [...undoStackRef.current, cloneSnapshot(baseline)].slice(-HISTORY_LIMIT);
      redoStackRef.current = [];
      setHistoryBaseline(nextSnapshot);
      syncHistoryFlags();
    }, 220);

    return () => {
      if (historyTimeoutRef.current) {
        window.clearTimeout(historyTimeoutRef.current);
      }
    };
  }, [annotations, boardImages, hasHydratedLocalState, notes, shapes, strokes, toolMode, viewportOffset, viewportScale, workspaceGoal]);

  useEffect(() => {
    function syncWorkspaceContext(nextValue?: unknown) {
      setWorkspaceContext(nextValue ? (nextValue as WorkspaceContext) : readWorkspaceContext());
    }

    syncWorkspaceContext();

    function onWorkspaceContext(event: Event) {
      syncWorkspaceContext((event as CustomEvent).detail);
    }

    window.addEventListener(WORKSPACE_CONTEXT_EVENT, onWorkspaceContext);
    return () => {
      window.removeEventListener(WORKSPACE_CONTEXT_EVENT, onWorkspaceContext);
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedLocalState) return;

    let cancelled = false;

    async function loadRemoteBoards() {
      setRemoteSyncLoading(true);
      try {
        const response = await fetch("/api/workspace/whiteboard-state", { cache: "no-store" });
        const data = (await safeJson(response)) as WhiteboardStateResponse | null;
        if (!response.ok || !data.ok) {
          throw new Error(data?.error || "We couldn't reach your saved workspace boards.");
        }
        if (cancelled) return;
        setRemoteBoards(data.boards || []);
        setRemoteSavedAt(data.savedAt || null);
        if (data.boardId) {
          setActiveBoardId(data.boardId);
          setBoardName(data.boardName || "Untitled board");
        }
        if (data.snapshot && !hasLocalSnapshot) {
          historySuspendRef.current = true;
          applySnapshot(sanitizePersistedState(data.snapshot));
          setHistoryBaseline(sanitizePersistedState(data.snapshot));
          window.setTimeout(() => {
            historySuspendRef.current = false;
          }, 0);
        }
      } catch (error) {
        if (!cancelled && error instanceof Error && !/Unauthorized/i.test(error.message)) {
          toast.error(error.message);
        }
      } finally {
        if (!cancelled) {
          setRemoteSyncLoading(false);
          setHasResolvedInitialRemoteState(true);
        }
      }
    }

    void loadRemoteBoards();

    return () => {
      cancelled = true;
    };
  }, [hasHydratedLocalState, hasLocalSnapshot]);

  useEffect(() => {
    if (!hasHydratedLocalState || !hasResolvedInitialRemoteState) return;

    const command = searchParams.get("whiteboardCommand");
    const prompt = searchParams.get("commandPrompt") || "";
    const commandGoal = searchParams.get("commandGoal") || "";
    const intent = searchParams.get("whiteboardIntent");
    const commandKey = `${command || ""}|${intent || ""}|${prompt}|${commandGoal}`;
    if (!command || processedCommandRef.current === commandKey) return;

    processedCommandRef.current = commandKey;
    setShowCopilot(true);
    if (commandGoal.trim()) {
      setWorkspaceGoal(commandGoal.trim());
    }
    if (prompt.trim()) {
      setAnnotationDraft(prompt.trim());
    }

    let commandPromise: Promise<void> | null = null;
    if (command === "assist" && isWhiteboardAssistIntent(intent)) {
      commandPromise = requestAssist(intent, { workspaceGoal: commandGoal.trim() || workspaceGoal });
    } else if (command === "image") {
      commandPromise = generateBoardImageFromPrompt({ prompt: prompt.trim(), workspaceGoal: commandGoal.trim() || workspaceGoal });
    } else if (command === "prefill") {
      toast.success("Whiteboard prompt loaded into Workspace Copilot.");
    }

    if (commandPromise) {
      void commandPromise;
    }

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("whiteboardCommand");
    nextParams.delete("whiteboardIntent");
    nextParams.delete("commandPrompt");
    nextParams.delete("commandGoal");
    const nextHref = nextParams.toString() ? `${pathname}?${nextParams.toString()}` : pathname;
    router.replace(nextHref, { scroll: false });
  }, [hasHydratedLocalState, hasResolvedInitialRemoteState, pathname, router, searchParams]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    for (const stroke of strokes) {
      drawStroke(context, stroke);
    }
  }, [strokes]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (event.pointerType === "touch" && activeTouchPointsRef.current.has(event.pointerId)) {
        activeTouchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pinchGestureRef.current && updatePinchGesture()) {
          return;
        }
      }

      if (panState && event.pointerId === panState.pointerId) {
        setViewportOffset({
          x: panState.startOffset.x + (event.clientX - panState.startClient.x),
          y: panState.startOffset.y + (event.clientY - panState.startClient.y),
        });
        return;
      }

      if (selectionDragState && event.pointerId === selectionDragState.pointerId) {
        const deltaX = (event.clientX - selectionDragState.startClient.x) / viewportScale;
        const deltaY = (event.clientY - selectionDragState.startClient.y) / viewportScale;

        setStrokes((current) => current.map((stroke) => {
          const origin = selectionDragState.strokeOrigins.find((item) => item.id === stroke.id);
          if (!origin) return stroke;
          return {
            ...stroke,
            points: origin.points.map((point) => ({
              x: clamp(point.x + deltaX, 0, CANVAS_WIDTH),
              y: clamp(point.y + deltaY, 0, CANVAS_HEIGHT),
            })),
          };
        }));

        setNotes((current) => current.map((note) => {
          const origin = selectionDragState.noteOrigins.find((item) => item.id === note.id);
          if (!origin) return note;
          return {
            ...note,
            x: clamp(origin.x + deltaX, 0, CANVAS_WIDTH - note.width),
            y: clamp(origin.y + deltaY, 0, CANVAS_HEIGHT - note.height),
          };
        }));

        setBoardImages((current) => current.map((image) => {
          const origin = selectionDragState.imageOrigins.find((item) => item.id === image.id);
          if (!origin) return image;
          return {
            ...image,
            x: clamp(origin.x + deltaX, 0, CANVAS_WIDTH - image.width),
            y: clamp(origin.y + deltaY, 0, CANVAS_HEIGHT - image.height),
          };
        }));

        setShapes((current) => current.map((shape) => {
          const origin = selectionDragState.shapeOrigins.find((item) => item.id === shape.id);
          if (!origin) return shape;
          if (shape.kind === "rectangle" && origin.kind === "rectangle") {
            return {
              ...shape,
              x: clamp((origin.x || 0) + deltaX, 0, CANVAS_WIDTH - shape.width),
              y: clamp((origin.y || 0) + deltaY, 0, CANVAS_HEIGHT - shape.height),
            };
          }
          if (shape.kind === "arrow" && origin.kind === "arrow" && origin.start && origin.end) {
            return {
              ...shape,
              start: { x: clamp(origin.start.x + deltaX, 0, CANVAS_WIDTH), y: clamp(origin.start.y + deltaY, 0, CANVAS_HEIGHT) },
              end: { x: clamp(origin.end.x + deltaX, 0, CANVAS_WIDTH), y: clamp(origin.end.y + deltaY, 0, CANVAS_HEIGHT) },
            };
          }
          return shape;
        }));
        return;
      }

      if (resizeState && event.pointerId === resizeState.pointerId) {
        const deltaX = (event.clientX - resizeState.startClient.x) / viewportScale;
        const deltaY = (event.clientY - resizeState.startClient.y) / viewportScale;

        if (resizeState.kind === "note") {
          const nextRect = resizeBox(resizeState.origin, resizeState.handle, deltaX, deltaY, MIN_NOTE_WIDTH, MIN_NOTE_HEIGHT);
          setNotes((current) => current.map((note) => note.id === resizeState.noteId ? { ...note, ...clampRectToBoard(nextRect) } : note));
          return;
        }

        if (resizeState.kind === "rectangle") {
          const nextRect = resizeBox(resizeState.origin, resizeState.handle, deltaX, deltaY, MIN_RECT_WIDTH, MIN_RECT_HEIGHT);
          setShapes((current) => current.map((shape) => shape.id === resizeState.shapeId && shape.kind === "rectangle" ? { ...shape, ...clampRectToBoard(nextRect) } : shape));
          return;
        }

        if (resizeState.kind === "image") {
          const nextRect = resizeBox(resizeState.origin, resizeState.handle, deltaX, deltaY, MIN_BOARD_IMAGE_WIDTH, MIN_BOARD_IMAGE_HEIGHT);
          setBoardImages((current) => current.map((image) => image.id === resizeState.imageId ? { ...image, ...clampRectToBoard(nextRect) } : image));
          return;
        }

        const nextPoint = {
          x: clamp(resizeState.kind === "arrow-start" ? resizeState.originStart.x + deltaX : resizeState.originEnd.x + deltaX, 0, CANVAS_WIDTH),
          y: clamp(resizeState.kind === "arrow-start" ? resizeState.originStart.y + deltaY : resizeState.originEnd.y + deltaY, 0, CANVAS_HEIGHT),
        };

        setShapes((current) => current.map((shape) => {
          if (shape.id !== resizeState.shapeId || shape.kind !== "arrow") return shape;
          return resizeState.kind === "arrow-start" ? { ...shape, start: nextPoint } : { ...shape, end: nextPoint };
        }));
        return;
      }

      if (selectionBox && event.pointerId === selectionBox.pointerId) {
        const point = getBoardPoint(event.clientX, event.clientY, boardViewportRef.current, viewportOffset, viewportScale);
        if (!point) return;
        setSelectionBox((current) => current ? { ...current, current: point } : current);
      }
    }

    function onPointerUp(event: PointerEvent) {
      if (event.pointerType === "touch") {
        activeTouchPointsRef.current.delete(event.pointerId);
        if (pinchGestureRef.current?.pointerIds.includes(event.pointerId)) {
          pinchGestureRef.current = null;
          resumeTouchPanAfterPinch();
        }
      }

      if (panState && event.pointerId === panState.pointerId) setPanState(null);
      if (selectionDragState && event.pointerId === selectionDragState.pointerId) setSelectionDragState(null);
      if (resizeState && event.pointerId === resizeState.pointerId) setResizeState(null);
      if (selectionBox && event.pointerId === selectionBox.pointerId) {
        finalizeSelectionBox(selectionBox);
        setSelectionBox(null);
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [boardImages, panState, resizeState, selectionBox, selectionDragState, viewportOffset, viewportScale]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;

      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoBoardState();
        } else {
          undoBoardState();
        }
        return;
      }

      if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoBoardState();
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (!selectedStrokeIds.length && !selectedNoteIds.length && !selectedShapeIds.length && !selectedImageIds.length) return;

      event.preventDefault();
      removeSelectedItems();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedImageIds, selectedNoteIds, selectedShapeIds, selectedStrokeIds, shapes, notes, boardImages, strokes, annotations, workspaceGoal, viewportScale, viewportOffset, toolMode]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      if (!imageItem) return;

      const file = imageItem.getAsFile();
      if (!file) return;

      event.preventDefault();
      void addBoardImageFromFile(file, file.name || "Pasted image");
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [boardImages.length, viewportOffset.x, viewportOffset.y, viewportScale]);

  useEffect(() => {
    return () => {
      if (sourceObjectUrlRef.current) URL.revokeObjectURL(sourceObjectUrlRef.current);
      pdfDocumentRef.current?.destroy?.();
      if (historyTimeoutRef.current) window.clearTimeout(historyTimeoutRef.current);
    };
  }, []);

  const boardSummary = useMemo(() => {
    const selectedCount = selectedStrokeIds.length + selectedNoteIds.length + selectedShapeIds.length + selectedImageIds.length;
    const selectionText = selectedCount ? `, ${selectedCount} selected` : "";
    return `${strokes.length} sketch stroke${strokes.length === 1 ? "" : "s"}, ${shapes.length} shape${shapes.length === 1 ? "" : "s"}, ${notes.length} note${notes.length === 1 ? "" : "s"}, ${boardImages.length} image${boardImages.length === 1 ? "" : "s"}, ${annotations.length} annotation${annotations.length === 1 ? "" : "s"}${selectionText}`;
  }, [annotations.length, boardImages.length, notes.length, selectedImageIds.length, selectedNoteIds.length, selectedShapeIds.length, selectedStrokeIds.length, shapes.length, strokes.length]);

  const toolRail = [
    { mode: "select" as ToolMode, short: "Sel", label: "Select" },
    { mode: "draw" as ToolMode, short: "Pen", label: "Draw" },
    { mode: "erase" as ToolMode, short: "Erase", label: "Eraser" },
    { mode: "pan" as ToolMode, short: "Pan", label: "Pan" },
    { mode: "rectangle" as ToolMode, short: "Box", label: "Rectangle" },
    { mode: "arrow" as ToolMode, short: "Arr", label: "Arrow" },
    { mode: "note" as ToolMode, short: "Note", label: "Sticky note" },
  ];
  const activeTool = toolRail.find((item) => item.mode === toolMode) ?? toolRail[0];
  const selectionSummary = useMemo(() => {
    const totalSelected = selectedStrokeIds.length + selectedShapeIds.length + selectedNoteIds.length + selectedImageIds.length;
    if (!totalSelected) return "Nothing selected";
    return `${selectedStrokeIds.length} stroke${selectedStrokeIds.length === 1 ? "" : "s"}, ${selectedShapeIds.length} shape${selectedShapeIds.length === 1 ? "" : "s"}, ${selectedNoteIds.length} note${selectedNoteIds.length === 1 ? "" : "s"}, ${selectedImageIds.length} image${selectedImageIds.length === 1 ? "" : "s"}`;
  }, [selectedImageIds.length, selectedNoteIds.length, selectedShapeIds.length, selectedStrokeIds.length]);

  const boardTransform = useMemo(
    () => `translate(${viewportOffset.x}px, ${viewportOffset.y}px) scale(${viewportScale})`,
    [viewportOffset.x, viewportOffset.y, viewportScale]
  );

  const selectionBoxRect = selectionBox ? normalizeSelectionBox(selectionBox) : null;
  const canManipulateSelection = toolMode === "select";
  const selectedCount = selectedStrokeIds.length + selectedNoteIds.length + selectedShapeIds.length + selectedImageIds.length;
  const inferredTaskCount = useMemo(
    () => inferTaskCount(notes.map((note) => note.text), annotations, workspaceGoal),
    [annotations, notes, workspaceGoal]
  );
  const recentActivity = useMemo(
    () => workspaceContext.recentTutorInteractions.slice(-2).reverse(),
    [workspaceContext.recentTutorInteractions]
  );
  const copilotObservations = useMemo(
    () => buildWhiteboardObservations({
      noteCount: notes.length,
      shapeCount: shapes.length,
      strokeCount: strokes.length,
      annotationCount: annotations.length,
      selectedCount,
      sourceAttachmentName,
      workspaceGoal,
      inferredTaskCount,
      hasAssistSuggestion: Boolean(assistSuggestion),
      recentTutorInteractionCount: workspaceContext.recentTutorInteractions.length,
    }),
    [annotations.length, assistSuggestion, inferredTaskCount, notes.length, selectedCount, shapes.length, sourceAttachmentName, strokes.length, workspaceContext.recentTutorInteractions.length, workspaceGoal]
  );
  const workspaceMemory = useMemo(() => {
    const items: string[] = [];
    if (workspaceContext.whiteboardReference?.updatedAt) {
      items.push(`Last active ${formatSavedAt(workspaceContext.whiteboardReference.updatedAt)}`);
    }
    if (workspaceContext.whiteboardReference?.workspaceGoal) {
      items.push(`Focus: ${workspaceContext.whiteboardReference.workspaceGoal}`);
    }
    if (workspaceContext.whiteboardReference?.sourceAttachmentName) {
      items.push(`Source: ${workspaceContext.whiteboardReference.sourceAttachmentName}`);
    }
    if (workspaceContext.tutorMemory?.recentGuidance?.[0]) {
      items.push(`Recent guidance: ${workspaceContext.tutorMemory.recentGuidance[0]}`);
    }
    return items.slice(0, 4);
  }, [workspaceContext]);
  const workspaceChatHref = useMemo(
    () => buildWorkspaceChatHref({
      boardName,
      workspaceGoal,
      inferredTaskCount,
      observations: copilotObservations,
    }),
    [boardName, copilotObservations, inferredTaskCount, workspaceGoal]
  );

  function undoBoardState() {
    if (!undoStackRef.current.length) return;
    const previous = undoStackRef.current[undoStackRef.current.length - 1];
    const current = cloneSnapshot(currentSnapshot());
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, current].slice(-HISTORY_LIMIT);
    syncHistoryFlags();
    restoreSnapshot(previous);
  }

  function redoBoardState() {
    if (!redoStackRef.current.length) return;
    const next = redoStackRef.current[redoStackRef.current.length - 1];
    const current = cloneSnapshot(currentSnapshot());
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, current].slice(-HISTORY_LIMIT);
    syncHistoryFlags();
    restoreSnapshot(next);
  }

  function finalizeSelectionBox(box: SelectionBox) {
    const rect = normalizeSelectionBox(box);
    const selectedStrokes = strokes.filter((stroke) => rectsIntersect(rect, getStrokeBounds(stroke))).map((stroke) => stroke.id);
    const selectedNotes = notes.filter((note) => rectsIntersect(rect, { x: note.x, y: note.y, width: note.width, height: note.height })).map((note) => note.id);
    const selectedImages = boardImages.filter((image) => rectsIntersect(rect, { x: image.x, y: image.y, width: image.width, height: image.height })).map((image) => image.id);
    const selectedShapes = shapes.filter((shape) => rectsIntersect(rect, getShapeBounds(shape))).map((shape) => shape.id);
    setSelectedStrokeIds(box.append ? unionIds(selectedStrokeIds, selectedStrokes) : selectedStrokes);
    setSelectedNoteIds(box.append ? unionIds(selectedNoteIds, selectedNotes) : selectedNotes);
    setSelectedImageIds(box.append ? unionIds(selectedImageIds, selectedImages) : selectedImages);
    setSelectedShapeIds(box.append ? unionIds(selectedShapeIds, selectedShapes) : selectedShapes);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "touch") {
      activeTouchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activeTouchPointsRef.current.size >= 2) {
        beginPinchGesture();
        return;
      }
    }

    activeCanvasPointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      activeCanvasPointerIdRef.current = null;
    }

    if (toolMode === "pan") {
      setPanState({
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        startOffset: viewportOffset,
      });
      return;
    }

    const point = getBoardPoint(event.clientX, event.clientY, boardViewportRef.current, viewportOffset, viewportScale);
    if (!point) return;

    if (toolMode === "select") {
      const hitImage = findBoardImageAtPoint(boardImages, point);
      if (hitImage) {
        const nextImageIds = event.shiftKey ? toggleId(selectedImageIds, hitImage.id, true) : [hitImage.id];
        if (!event.shiftKey) {
          setSelectedStrokeIds([]);
          setSelectedNoteIds([]);
          setSelectedShapeIds([]);
        }
        setSelectedImageIds(nextImageIds);
        if (nextImageIds.includes(hitImage.id)) {
          startSelectionDrag(event.pointerId, event.clientX, event.clientY, { imageIds: nextImageIds });
        }
        return;
      }

      const hitStroke = findStrokeAtPoint(strokes, point);
      if (hitStroke) {
        const nextStrokeIds = event.shiftKey ? toggleId(selectedStrokeIds, hitStroke.id, true) : [hitStroke.id];
        if (!event.shiftKey) {
          setSelectedNoteIds([]);
          setSelectedShapeIds([]);
          setSelectedImageIds([]);
        }
        setSelectedStrokeIds(nextStrokeIds);
        if (nextStrokeIds.includes(hitStroke.id)) {
          startSelectionDrag(event.pointerId, event.clientX, event.clientY, { strokeIds: nextStrokeIds });
        }
        return;
      }

      setSelectionBox({
        pointerId: event.pointerId,
        start: point,
        current: point,
        append: event.shiftKey,
      });
      if (!event.shiftKey) clearSelection();
      return;
    }

    if (toolMode === "draw") {
      const nextStroke: Stroke = { id: createStrokeId(), color: penColor, width: penWidth, points: [point] };
      drawingStrokeRef.current = nextStroke;
      setStrokes((current) => [...current, nextStroke]);
      return;
    }

    if (toolMode === "erase") {
      eraseAtPoint(point);
      return;
    }

    if (toolMode === "rectangle" || toolMode === "arrow") {
      setDraftShape({ kind: toolMode, start: point, current: point });
      return;
    }

    if (toolMode === "note") {
      const noteText = annotationDraft.trim() || "New note";
      const note = createNote(noteText, clamp(point.x, 0, CANVAS_WIDTH - DEFAULT_NOTE_WIDTH), clamp(point.y, 0, CANVAS_HEIGHT - DEFAULT_NOTE_HEIGHT), noteColor);
      setNotes((current) => [...current, note]);
      setToolMode("select");
      setSelectedStrokeIds([]);
      setSelectedNoteIds([note.id]);
      setSelectedShapeIds([]);
      setSelectedImageIds([]);
      if (annotationDraft.trim()) setAnnotationDraft("");
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "touch" && activeTouchPointsRef.current.has(event.pointerId)) {
      activeTouchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchGestureRef.current && updatePinchGesture()) {
        return;
      }
    }

    if (activeCanvasPointerIdRef.current !== null && event.pointerId !== activeCanvasPointerIdRef.current) {
      return;
    }

    const point = getBoardPoint(event.clientX, event.clientY, boardViewportRef.current, viewportOffset, viewportScale);
    if (!point) return;

    if (drawingStrokeRef.current) {
      drawingStrokeRef.current = {
        ...drawingStrokeRef.current,
        points: [...drawingStrokeRef.current.points, point],
      };
      setStrokes((current) => {
        const copy = [...current];
        copy[copy.length - 1] = drawingStrokeRef.current as Stroke;
        return copy;
      });
      return;
    }

    if (toolMode === "erase") {
      eraseAtPoint(point);
      return;
    }

    if (draftShape) {
      setDraftShape({ ...draftShape, current: point });
    }
  }

  function finishPointerAction(event?: React.PointerEvent<HTMLCanvasElement>) {
    if (event?.pointerType === "touch") {
      activeTouchPointsRef.current.delete(event.pointerId);
      if (pinchGestureRef.current?.pointerIds.includes(event.pointerId)) {
        pinchGestureRef.current = null;
        activeCanvasPointerIdRef.current = null;
        drawingStrokeRef.current = null;
        resumeTouchPanAfterPinch();
        return;
      }
    }

    const pointerId = activeCanvasPointerIdRef.current;
    if (event && pointerId !== null && event.currentTarget.hasPointerCapture(pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(pointerId);
      } catch {
        // Ignore release failures during rapid pointer transitions.
      }
    }
    activeCanvasPointerIdRef.current = null;
    drawingStrokeRef.current = null;

    if (draftShape) {
      const nextShape = toBoardShape(draftShape, penColor);
      if (nextShape) {
        setShapes((current) => [...current, nextShape]);
        setToolMode("select");
        setSelectedStrokeIds([]);
        setSelectedShapeIds([nextShape.id]);
        setSelectedNoteIds([]);
        setSelectedImageIds([]);
      }
      setDraftShape(null);
    }
  }

  function clearBoard() {
    setStrokes([]);
    setShapes([]);
    setNotes([]);
    setBoardImages([]);
    setAnnotations([]);
    setAnnotationDraft("");
    setAssistSuggestion(null);
    setShowOverlayGuide(true);
    setViewportScale(1);
    setViewportOffset({ x: 0, y: 0 });
    clearSelection();
    setRemoteSavedAt(null);
    window.localStorage.removeItem(WHITEBOARD_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_WHITEBOARD_STORAGE_KEY);
  }

  function addAnnotation() {
    const trimmed = annotationDraft.trim();
    if (!trimmed) return;
    setAnnotations((current) => [trimmed, ...current].slice(0, 8));
    setAnnotationDraft("");
  }

  function addStickyNoteFromDraft() {
    const noteText = annotationDraft.trim();
    if (!noteText) return;
    const note = createNote(noteText, 60, 60 + notes.length * 18, noteColor);
    setNotes((current) => [...current, note]);
    setAnnotationDraft("");
    setToolMode("select");
    setSelectedStrokeIds([]);
    setSelectedNoteIds([note.id]);
    setSelectedShapeIds([]);
    setSelectedImageIds([]);
  }

  async function requestAssist(intent: WhiteboardAssistIntent, overrides?: { workspaceGoal?: string }) {
    setAssistLoading(intent);
    try {
      const effectiveWorkspaceGoal = overrides?.workspaceGoal ?? workspaceGoal;
      const response = await fetch("/api/workspace/whiteboard-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent,
          workspaceGoal: effectiveWorkspaceGoal,
          annotations,
          boardSummary,
          hasSourceAttachment: Boolean(sourceAttachmentName),
        }),
      });

      const data = await safeJson(response);
      if (!response.ok || !data?.ok || !data.suggestion) {
        throw new Error(data?.error || "Whiteboard assist is unavailable right now.");
      }
      setAssistSuggestion(data.suggestion as WhiteboardAssistSuggestion);
      setShowOverlayGuide(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Whiteboard assist is unavailable right now.");
    } finally {
      setAssistLoading(null);
    }
  }

  function applyAssistSuggestion() {
    if (!assistSuggestion) return;

    const nextNotes = assistSuggestion.nodes.map((node, index) => ({
      id: `ai-note-${Date.now()}-${index}`,
      x: clamp(node.x * CANVAS_WIDTH - 80, 0, CANVAS_WIDTH - DEFAULT_NOTE_WIDTH),
      y: clamp(node.y * CANVAS_HEIGHT - 35, 0, CANVAS_HEIGHT - DEFAULT_NOTE_HEIGHT),
      width: DEFAULT_NOTE_WIDTH,
      height: DEFAULT_NOTE_HEIGHT,
      text: node.label,
      color: "#DBEAFE",
    }));

    const nodeLookup = new Map(assistSuggestion.nodes.map((node) => [node.id, node]));
    const nextShapes: BoardShape[] = assistSuggestion.connections.flatMap((connection, index) => {
      const from = nodeLookup.get(connection.from);
      const to = nodeLookup.get(connection.to);
      if (!from || !to) return [];
      return [{
        id: `ai-arrow-${Date.now()}-${index}`,
        kind: "arrow",
        start: { x: from.x * CANVAS_WIDTH, y: from.y * CANVAS_HEIGHT },
        end: { x: to.x * CANVAS_WIDTH, y: to.y * CANVAS_HEIGHT },
        color: "#0284C7",
      }];
    });

    setNotes((current) => [...current, ...nextNotes]);
    setShapes((current) => [...current, ...nextShapes]);
    setSelectedStrokeIds([]);
    setSelectedNoteIds(nextNotes.map((note) => note.id));
    setSelectedShapeIds(nextShapes.map((shape) => shape.id));
    setSelectedImageIds([]);
    setToolMode("select");
    setShowOverlayGuide(false);
    toast.success("Applied the AI guide onto the board as editable notes and connectors.");
  }

  async function handleSourceAttachment(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setSourceAttachmentName(file.name);
    pdfDocumentRef.current?.destroy?.();
    pdfDocumentRef.current = null;
    setPdfPageCount(0);
    setPdfCurrentPage(1);

    if (sourceObjectUrlRef.current) {
      URL.revokeObjectURL(sourceObjectUrlRef.current);
      sourceObjectUrlRef.current = null;
    }

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      setPdfLoading(true);
      try {
        await loadPdfDocument(file);
        setSourceOverlayKind("pdf");
      } catch (error) {
        setSourceAttachmentUrl(null);
        setSourceAttachmentName(null);
        setSourceOverlayKind(null);
        toast.error(error instanceof Error ? error.message : "We couldn't render that PDF on the board.");
      } finally {
        setPdfLoading(false);
      }
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    sourceObjectUrlRef.current = objectUrl;
    setSourceAttachmentUrl(objectUrl);
    setSourceOverlayKind("image");
  }

  async function handleBoardImageAttachment(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await addBoardImageFromFile(file, file.name);
      toast.success("Image added to the board.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't add that image to the board.");
    } finally {
      event.target.value = "";
    }
  }

  async function addBoardImageFromFile(file: Blob, name: string) {
    const dataUrl = await readBlobAsDataUrl(file);
    await placeBoardImageFromUrl(dataUrl, name);
  }

  async function placeBoardImageFromUrl(src: string, name: string) {
    const image = await loadImage(src);
    const { width, height } = getContainedSize(image.width, image.height, DEFAULT_BOARD_IMAGE_WIDTH, DEFAULT_BOARD_IMAGE_HEIGHT);
    const viewportCenter = getBoardViewportCenter();
    const nextImage: BoardImage = {
      id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      x: clamp(viewportCenter.x - width / 2, 0, CANVAS_WIDTH - width),
      y: clamp(viewportCenter.y - height / 2, 0, CANVAS_HEIGHT - height),
      width,
      height,
      src,
      name,
    };
    setBoardImages((current) => [...current, nextImage]);
    setSelectedStrokeIds([]);
    setSelectedNoteIds([]);
    setSelectedShapeIds([]);
    setSelectedImageIds([nextImage.id]);
    setToolMode("select");
  }

  async function generateBoardImageFromPrompt(overrides?: { prompt?: string; workspaceGoal?: string }) {
    const prompt = (overrides?.prompt ?? annotationDraft).trim();
    if (!prompt) {
      toast.error("Add an image prompt first.");
      return;
    }

    setImagePromptLoading(true);
    try {
      const effectiveWorkspaceGoal = overrides?.workspaceGoal ?? workspaceGoal;
      const response = await fetch("/api/workspace/whiteboard-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          workspaceGoal: effectiveWorkspaceGoal,
          boardSummary,
          annotations,
        }),
      });

      const data = await safeJson(response);
      if (!response.ok || !data?.ok || typeof data?.imageUrl !== "string") {
        throw new Error(data?.error || "Image generation is unavailable right now.");
      }

      await placeBoardImageFromUrl(data.imageUrl, truncateText(prompt, 48) || "AI image");
      toast.success("Generated image placed on the board.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Image generation is unavailable right now.");
    } finally {
      setImagePromptLoading(false);
    }
  }

  async function downloadBoard(format: ExportFormat) {
    setExportingFormat(format);
    try {
      if (format === "svg") {
        const svgMarkup = renderBoardSvg({
          sourceAttachmentUrl,
          strokes,
          shapes,
          notes,
          images: boardImages,
        });
        const svgBlob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
        const svgUrl = URL.createObjectURL(svgBlob);
        triggerDownload(svgUrl, "mate-e-workspace-board.svg");
        window.setTimeout(() => URL.revokeObjectURL(svgUrl), 0);
        return;
      }

      const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
      const snapshotUrl = await renderBoardSnapshot({
        sourceAttachmentUrl,
        strokes,
        shapes,
        notes,
        images: boardImages,
        mimeType,
        quality: format === "jpeg" || format === "webp" ? 0.92 : undefined,
      });

      triggerDownload(snapshotUrl, `mate-e-workspace-board.${format === "jpeg" ? "jpg" : format}`);
    } catch {
      toast.error("We couldn't export the board right now.");
    } finally {
      setExportingFormat(null);
    }
  }

  async function shareBoard() {
    if (!activeBoardId) {
      toast.message("Save the board first, then share it.");
      return;
    }

    try {
      const shareUrl = `${window.location.origin}/app/workspace/whiteboard?boardId=${encodeURIComponent(activeBoardId)}`;
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Board link copied to clipboard.");
    } catch {
      toast.error("We couldn't copy the board link right now.");
    }
  }

  async function loadPdfDocument(file: File) {
    const pdfjsLib = await loadPdfJsRuntime();
    if (!pdfjsLib) {
      throw new Error("PDF board import is unavailable in this environment right now.");
    }

    const fileData = new Uint8Array(await file.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({ data: fileData });
    const pdfDocument = (await loadingTask.promise) as PdfDocumentLike;
    pdfDocumentRef.current = pdfDocument;
    setPdfPageCount(pdfDocument.numPages);
    await renderPdfPage(pdfDocument, 1);
  }

  async function loadPdfJsRuntime() {
    const candidates = [
      "pdfjs-dist/legacy/build/pdf.mjs",
      "pdfjs-dist/build/pdf.mjs",
      "pdfjs-dist",
    ];

    for (const specifier of candidates) {
      try {
        const mod = await runtimeImport(specifier);
        const pdfjsLib = mod?.default && typeof mod.default.getDocument === "function" ? mod.default : mod;
        if (pdfjsLib && typeof pdfjsLib.getDocument === "function") {
          return pdfjsLib;
        }
      } catch {
        // Try the next candidate. Some installs ship different PDF.js entry points.
      }
    }

    return null;
  }

  async function renderPdfPage(document: PdfDocumentLike, pageNumber: number) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.35 });
    const renderCanvas = window.document.createElement("canvas");
    renderCanvas.width = viewport.width;
    renderCanvas.height = viewport.height;
    const renderContext = renderCanvas.getContext("2d");
    if (!renderContext) throw new Error("We couldn't prepare the PDF canvas.");

    await page.render({ canvasContext: renderContext, viewport }).promise;
    setSourceAttachmentUrl(renderCanvas.toDataURL("image/png"));
    setPdfCurrentPage(pageNumber);
  }

  async function goToPdfPage(nextPage: number) {
    if (!pdfDocumentRef.current) return;
    const clampedPage = Math.max(1, Math.min(pdfPageCount, nextPage));
    setPdfLoading(true);
    try {
      await renderPdfPage(pdfDocumentRef.current, clampedPage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't render that PDF page.");
    } finally {
      setPdfLoading(false);
    }
  }

  function nudgeZoom(delta: number) {
    setViewportScale((current) => clamp(round2(current + delta), 0.6, 2.5));
  }

  function resetViewport() {
    setViewportScale(1);
    setViewportOffset({ x: 0, y: 0 });
  }

  function eraseAtPoint(point: StrokePoint) {
    const strokeIdsToAdjust = strokes
      .filter((stroke) => isPointNearStroke(stroke, point, Math.max(10, stroke.width + 6)))
      .map((stroke) => stroke.id);
    const noteIdsToRemove = notes
      .filter((note) => pointInRect(point, { x: note.x, y: note.y, width: note.width, height: note.height }, 4))
      .map((note) => note.id);
    const imageIdsToRemove = boardImages
      .filter((image) => pointInRect(point, { x: image.x, y: image.y, width: image.width, height: image.height }, 4))
      .map((image) => image.id);
    const shapeIdsToRemove = shapes
      .filter((shape) => isPointNearShape(shape, point, 10))
      .map((shape) => shape.id);

    if (!strokeIdsToAdjust.length && !noteIdsToRemove.length && !imageIdsToRemove.length && !shapeIdsToRemove.length) {
      return;
    }

    if (strokeIdsToAdjust.length) {
      setStrokes((current) => current.flatMap((stroke) => {
        if (!strokeIdsToAdjust.includes(stroke.id)) return [stroke];
        return splitStrokeByEraser(stroke, point, Math.max(10, stroke.width + 6));
      }));
      setSelectedStrokeIds((current) => current.filter((id) => !strokeIdsToAdjust.includes(id)));
    }
    if (noteIdsToRemove.length) {
      setNotes((current) => current.filter((note) => !noteIdsToRemove.includes(note.id)));
      setSelectedNoteIds((current) => current.filter((id) => !noteIdsToRemove.includes(id)));
    }
    if (imageIdsToRemove.length) {
      setBoardImages((current) => current.filter((image) => !imageIdsToRemove.includes(image.id)));
      setSelectedImageIds((current) => current.filter((id) => !imageIdsToRemove.includes(id)));
    }
    if (shapeIdsToRemove.length) {
      setShapes((current) => current.filter((shape) => !shapeIdsToRemove.includes(shape.id)));
      setSelectedShapeIds((current) => current.filter((id) => !shapeIdsToRemove.includes(id)));
    }
  }

  function updateNoteText(noteId: string, text: string) {
    setNotes((current) => current.map((note) => note.id === noteId ? { ...note, text } : note));
  }

  function removeSelectedItems() {
    setStrokes((current) => current.filter((stroke) => !selectedStrokeIds.includes(stroke.id)));
    setNotes((current) => current.filter((note) => !selectedNoteIds.includes(note.id)));
    setBoardImages((current) => current.filter((image) => !selectedImageIds.includes(image.id)));
    setShapes((current) => current.filter((shape) => !selectedShapeIds.includes(shape.id)));
    clearSelection();
  }

  function updateRectangleText(shapeId: string, text: string) {
    setShapes((current) => current.map((shape) => shape.id === shapeId && shape.kind === "rectangle" ? { ...shape, text } : shape));
  }

  function selectImage(imageId: string, multi: boolean) {
    setSelectedStrokeIds((current) => (multi ? current : []));
    setSelectedNoteIds((current) => (multi ? current : []));
    setSelectedShapeIds((current) => (multi ? current : []));
    setSelectedImageIds((current) => toggleId(current, imageId, multi));
  }

  function selectNote(noteId: string, multi: boolean) {
    setSelectedShapeIds((current) => (multi ? current : []));
    setSelectedNoteIds((current) => toggleId(current, noteId, multi));
  }

  function selectShape(shapeId: string, multi: boolean) {
    setSelectedNoteIds((current) => (multi ? current : []));
    setSelectedShapeIds((current) => toggleId(current, shapeId, multi));
  }

  function startSelectionDrag(
    pointerId: number,
    clientX: number,
    clientY: number,
    selection: {
      strokeIds?: string[];
      noteIds?: string[];
      shapeIds?: string[];
      imageIds?: string[];
    } = {}
  ) {
    const strokeIds = selection.strokeIds ?? selectedStrokeIds;
    const noteIds = selection.noteIds ?? selectedNoteIds;
    const shapeIds = selection.shapeIds ?? selectedShapeIds;
    const imageIds = selection.imageIds ?? selectedImageIds;
    setSelectionDragState({
      pointerId,
      startClient: { x: clientX, y: clientY },
      strokeOrigins: strokes.filter((stroke) => strokeIds.includes(stroke.id)).map((stroke) => ({
        id: stroke.id,
        points: stroke.points.map((point) => ({ ...point })),
      })),
      noteOrigins: notes.filter((note) => noteIds.includes(note.id)).map((note) => ({ id: note.id, x: note.x, y: note.y })),
      imageOrigins: boardImages.filter((image) => imageIds.includes(image.id)).map((image) => ({ id: image.id, x: image.x, y: image.y })),
      shapeOrigins: shapes.filter((shape) => shapeIds.includes(shape.id)).map((shape) =>
        shape.kind === "rectangle"
          ? { id: shape.id, kind: shape.kind, x: shape.x, y: shape.y }
          : { id: shape.id, kind: shape.kind, start: shape.start, end: shape.end }
      ),
    });
  }

  function handleNoteHeaderPointerDown(noteId: string, event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    const alreadySelected = selectedNoteIds.includes(noteId);
    const multi = event.shiftKey;
    if (!alreadySelected || !multi) {
      selectNote(noteId, multi);
    }
    if (toolMode === "select") {
      const selected = alreadySelected && !multi ? selectedNoteIds : multi ? toggleId(selectedNoteIds, noteId, true) : [noteId];
      if (!selected.includes(noteId)) return;
      startSelectionDrag(event.pointerId, event.clientX, event.clientY, { noteIds: selected });
    }
  }

  function handleNoteBodyPointerDown(noteId: string, event: React.PointerEvent<HTMLDivElement>) {
    if (toolMode !== "select") return;
    event.stopPropagation();
    selectNote(noteId, event.shiftKey);
  }

  function startNoteResize(note: BoardNote, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setToolMode("select");
    setSelectedNoteIds([note.id]);
    setSelectedShapeIds([]);
    setSelectedImageIds([]);
    setResizeState({
      pointerId: event.pointerId,
      kind: "note",
      noteId: note.id,
      handle,
      origin: { x: note.x, y: note.y, width: note.width, height: note.height },
      startClient: { x: event.clientX, y: event.clientY },
    });
  }

  function startRectangleResize(shape: BoardRectangle, handle: ResizeHandle, event: React.PointerEvent<SVGCircleElement>) {
    event.stopPropagation();
    setToolMode("select");
    setSelectedShapeIds([shape.id]);
    setSelectedNoteIds([]);
    setSelectedImageIds([]);
    setResizeState({
      pointerId: event.pointerId,
      kind: "rectangle",
      shapeId: shape.id,
      handle,
      origin: { x: shape.x, y: shape.y, width: shape.width, height: shape.height },
      startClient: { x: event.clientX, y: event.clientY },
    });
  }

  function startArrowHandleDrag(shape: BoardArrow, edge: "start" | "end", event: React.PointerEvent<SVGCircleElement>) {
    event.stopPropagation();
    setToolMode("select");
    setSelectedShapeIds([shape.id]);
    setSelectedNoteIds([]);
    setSelectedImageIds([]);
    setResizeState({
      pointerId: event.pointerId,
      kind: edge === "start" ? "arrow-start" : "arrow-end",
      shapeId: shape.id,
      startClient: { x: event.clientX, y: event.clientY },
      originStart: shape.start,
      originEnd: shape.end,
    });
  }

  function handleShapePointerDown(shapeId: string, event: React.PointerEvent<SVGElement>) {
    if (toolMode !== "select") return;
    event.stopPropagation();
    beginShapeSelection(shapeId, event.pointerId, event.clientX, event.clientY, event.shiftKey);
  }

  function handleRectangleFramePointerDown(shapeId: string, event: React.PointerEvent<HTMLDivElement>) {
    if (toolMode !== "select") return;
    event.stopPropagation();
    beginShapeSelection(shapeId, event.pointerId, event.clientX, event.clientY, event.shiftKey);
  }

  function beginShapeSelection(shapeId: string, pointerId: number, clientX: number, clientY: number, multi: boolean) {
    const alreadySelected = selectedShapeIds.includes(shapeId);
    if (!alreadySelected || !multi) {
      selectShape(shapeId, multi);
    }
    const selected = alreadySelected && !multi ? selectedShapeIds : multi ? toggleId(selectedShapeIds, shapeId, true) : [shapeId];
    if (!selected.includes(shapeId)) return;
    startSelectionDrag(pointerId, clientX, clientY, { shapeIds: selected });
  }

  function startImageResize(image: BoardImage, handle: ResizeHandle, event: React.PointerEvent<SVGCircleElement>) {
    event.stopPropagation();
    setToolMode("select");
    selectImage(image.id, false);
    setResizeState({
      pointerId: event.pointerId,
      kind: "image",
      imageId: image.id,
      handle,
      origin: { x: image.x, y: image.y, width: image.width, height: image.height },
      startClient: { x: event.clientX, y: event.clientY },
    });
  }

  function applyBoardPreset(presetId: BoardPresetId) {
    const preset = BOARD_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const snapshot = preset.create();
    setStrokes([]);
    setShapes(snapshot.shapes);
    setNotes(snapshot.notes);
    setAnnotations(snapshot.annotations);
    setWorkspaceGoal(snapshot.workspaceGoal);
    setAssistSuggestion(null);
    setShowOverlayGuide(true);
    clearSelection();
    setToolMode("select");
    resetViewport();
    toast.success(`${preset.label} preset loaded onto the board.`);
  }

  async function refreshRemoteBoards(preferredBoardId?: string | null) {
    const query = preferredBoardId ? `?boardId=${encodeURIComponent(preferredBoardId)}` : "";
    const response = await fetch(`/api/workspace/whiteboard-state${query}`, { cache: "no-store" });
    const data = (await safeJson(response)) as WhiteboardStateResponse | null;
    if (!response.ok || !data.ok) {
      throw new Error(data?.error || "We couldn't refresh your saved boards.");
    }
    setRemoteBoards(data.boards || []);
    return data;
  }

  async function saveBoardToCloud() {
    setRemoteSyncSaving(true);
    try {
      const response = await fetch("/api/workspace/whiteboard-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshot: currentSnapshot(),
          boardId: activeBoardId,
          boardName,
        }),
      });
      const data = (await safeJson(response)) as WhiteboardStateResponse | null;
      if (!response.ok || !data.ok) {
        throw new Error(data?.error || "We couldn't save your board to your account.");
      }
      setActiveBoardId(data.boardId || null);
      setBoardName(data.boardName || boardName || "Untitled board");
      setRemoteSavedAt(data.savedAt || new Date().toISOString());
      const refreshed = await refreshRemoteBoards(data.boardId || activeBoardId);
      setRemoteBoards(refreshed.boards || []);
      toast.success("Board saved to your account.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save your board to your account.");
    } finally {
      setRemoteSyncSaving(false);
    }
  }

  async function loadBoardFromCloud(boardId?: string) {
    setRemoteSyncLoading(true);
    try {
      const query = boardId ? `?boardId=${encodeURIComponent(boardId)}` : activeBoardId ? `?boardId=${encodeURIComponent(activeBoardId)}` : "";
      const response = await fetch(`/api/workspace/whiteboard-state${query}`, { cache: "no-store" });
      const data = (await safeJson(response)) as WhiteboardStateResponse | null;
      if (!response.ok || !data.ok) {
        throw new Error(data?.error || "We couldn't load your board from your account.");
      }
      setRemoteBoards(data.boards || []);
      if (!data.snapshot) {
        toast.message("No saved board found for this account yet.");
        return;
      }
      restoreSnapshot(sanitizePersistedState(data.snapshot));
      setActiveBoardId(data.boardId || null);
      setBoardName(data.boardName || "Untitled board");
      setRemoteSavedAt(data.savedAt || null);
      toast.success("Loaded your saved board from your account.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't load your board from your account.");
    } finally {
      setRemoteSyncLoading(false);
    }
  }

  async function deleteBoardFromCloud(boardId: string) {
    setRemoteSyncLoading(true);
    try {
      const response = await fetch("/api/workspace/whiteboard-state", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId }),
      });
      const data = (await safeJson(response)) as WhiteboardStateResponse | null;
      if (!response.ok || !data.ok) {
        throw new Error(data?.error || "We couldn't delete that saved board.");
      }
      const refreshed = await refreshRemoteBoards(activeBoardId === boardId ? undefined : activeBoardId);
      setRemoteBoards(refreshed.boards || []);
      if (activeBoardId === boardId) {
        createNewBoard();
      }
      toast.success("Saved board deleted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't delete that saved board.");
    } finally {
      setRemoteSyncLoading(false);
    }
  }

  async function renameBoardInCloud(boardId: string, nextName: string) {
    const trimmedName = nextName.trim();
    if (!trimmedName) {
      toast.error("Board name is required.");
      return;
    }

    setRemoteSyncLoading(true);
    try {
      const response = await fetch("/api/workspace/whiteboard-state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId, boardName: trimmedName }),
      });
      const data = (await safeJson(response)) as WhiteboardStateResponse | null;
      if (!response.ok || !data.ok) {
        throw new Error(data?.error || "We couldn't rename that saved board.");
      }
      const refreshed = await refreshRemoteBoards(boardId);
      setRemoteBoards(refreshed.boards || []);
      if (activeBoardId === boardId) {
        setBoardName(trimmedName);
      }
      setRenamingBoardId(null);
      setRenameDraft("");
      toast.success("Saved board renamed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't rename that saved board.");
    } finally {
      setRemoteSyncLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[2rem] border border-slate-200 bg-white/85 p-4 shadow-sm backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">AI Canvas</p>
            <input
              value={boardName}
              onChange={(event) => setBoardName(event.target.value)}
              placeholder="Untitled board"
              className="mt-2 w-full max-w-xl border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight text-slate-950 outline-none placeholder:text-slate-400"
            />
            <p className="mt-2 text-xs text-slate-500">{activeBoardId ? "Saved board" : "Unsaved board"} • {boardSummary}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={saveBoardToCloud} disabled={remoteSyncSaving} className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60">
              {remoteSyncSaving ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={shareBoard} className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50">
              Share
            </button>
            <button type="button" onClick={() => setShowControlsPanel((current) => !current)} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50">
              {showControlsPanel ? "Hide controls" : "Show controls"}
            </button>
            <button type="button" onClick={() => setShowCopilot((current) => !current)} className="rounded-full border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-medium text-cyan-950 hover:bg-cyan-100">
              {showCopilot ? "Hide AI Assist" : "AI Assist"}
            </button>
            <button type="button" onClick={undoBoardState} disabled={!canUndo} className="rounded-full border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50">
              Undo
            </button>
            <button type="button" onClick={redoBoardState} disabled={!canRedo} className="rounded-full border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-50">
              Redo
            </button>
            <details className="relative">
              <summary className="list-none cursor-pointer rounded-full border border-slate-300 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50">
                {exportingFormat ? `Exporting ${exportingFormat.toUpperCase()}...` : "Export"}
              </summary>
              <div className="absolute right-0 z-30 mt-2 w-[220px] rounded-3xl border border-slate-200 bg-white p-3 shadow-xl">
                <p className="px-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Visual downloads</p>
                <div className="mt-3 grid gap-2">
                  {[
                    ["png", "PNG image"],
                    ["jpeg", "JPG image"],
                    ["webp", "WebP image"],
                    ["svg", "SVG vector"],
                  ].map(([format, label]) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() => void downloadBoard(format as ExportFormat)}
                      disabled={exportingFormat !== null}
                      className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-60"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </details>
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden rounded-[2rem] border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-sky-50 shadow-sm">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.14),_transparent_34%),radial-gradient(circle_at_bottom_right,_rgba(16,185,129,0.12),_transparent_28%)]" />

        <div className="relative min-h-[80vh] p-4 md:p-6">
          <div className={isCompactViewport
            ? "absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 overflow-x-auto rounded-[1.5rem] border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur"
            : "absolute left-4 top-6 z-20 flex flex-col gap-2 rounded-[1.5rem] border border-slate-200 bg-white/90 p-2 shadow-lg backdrop-blur md:left-6"
          }>
            {toolRail.map((item) => (
              <button
                key={item.mode}
                type="button"
                title={item.label}
                onClick={() => setToolMode(item.mode)}
                className={toolMode === item.mode
                  ? "min-w-[60px] shrink-0 rounded-2xl bg-slate-950 px-3 py-3 text-center text-xs font-semibold uppercase tracking-[0.12em] text-white"
                  : "min-w-[60px] shrink-0 rounded-2xl bg-white px-3 py-3 text-center text-xs font-semibold uppercase tracking-[0.12em] text-slate-700 hover:bg-slate-50"
                }
              >
                {item.short}
              </button>
            ))}
            <div className={isCompactViewport ? "shrink-0 rounded-2xl border border-slate-200 bg-slate-50 p-2" : "mt-1 rounded-2xl border border-slate-200 bg-slate-50 p-2"}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Ink</p>
              <div className={isCompactViewport ? "mt-2 flex gap-2" : "mt-2 grid grid-cols-3 gap-2"}>
                {COLOR_SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={`Use ${color}`}
                    onClick={() => setPenColor(color)}
                    className={penColor === color
                      ? "h-7 w-7 rounded-full ring-2 ring-slate-950 ring-offset-2"
                      : "h-7 w-7 rounded-full ring-1 ring-slate-200"
                    }
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          </div>

          {showControlsPanel ? (
            <aside className={isCompactViewport
              ? "absolute inset-x-3 bottom-20 z-20 overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white/97 shadow-xl backdrop-blur"
              : "absolute left-4 top-28 z-20 w-full max-w-[320px] overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white/95 shadow-xl backdrop-blur md:left-[6.5rem] md:top-6"
            }>
              <div className={isCompactViewport ? "max-h-[60vh] overflow-y-auto p-4" : "max-h-[calc(100vh-13rem)] overflow-y-auto p-4"}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Whiteboard Controls</p>
                    <p className="mt-1 text-sm text-slate-600">Board tools, layout, assets, and saved board actions in one place.</p>
                  </div>
                  <button type="button" onClick={() => setShowControlsPanel(false)} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                    Hide
                  </button>
                </div>

                <div className="mt-4 space-y-4">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Tooling</p>
                      <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-medium text-cyan-900">Active: {activeTool.label}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {toolRail.map((item) => (
                        <button
                          key={item.mode}
                          type="button"
                          onClick={() => setToolMode(item.mode)}
                          className={toolMode === item.mode
                            ? "rounded-2xl bg-slate-950 px-3 py-2 text-left text-sm font-medium text-white"
                            : "rounded-2xl border border-slate-200 bg-white px-3 py-2 text-left text-sm font-medium text-slate-900 hover:bg-slate-50"
                          }
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-slate-500">Selection: {selectionSummary}</p>
                  </div>

                  <details className="rounded-2xl border border-slate-200 bg-slate-50 p-3" open>
                    <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Boards</summary>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => loadBoardFromCloud()} disabled={remoteSyncLoading} className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50 disabled:opacity-60">
                        {remoteSyncLoading ? "Loading..." : "Load latest"}
                      </button>
                      <button type="button" onClick={createNewBoard} className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50">
                        New
                      </button>
                      <button type="button" onClick={clearBoard} className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-slate-50">
                        Clear
                      </button>
                    </div>
                    <div className="mt-3 space-y-2">
                      {remoteBoards.length ? remoteBoards.map((board) => (
                        <div key={board.boardId} className={board.boardId === activeBoardId ? "rounded-2xl border border-cyan-300 bg-cyan-50 px-3 py-3" : "rounded-2xl border border-slate-200 bg-white px-3 py-3"}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              {renamingBoardId === board.boardId ? (
                                <div className="space-y-2">
                                  <input
                                    value={renameDraft}
                                    onChange={(event) => setRenameDraft(event.target.value)}
                                    className="w-full rounded-xl border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-slate-900"
                                  />
                                  <div className="flex flex-wrap gap-2">
                                    <button type="button" onClick={() => void renameBoardInCloud(board.boardId, renameDraft)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50">
                                      Save
                                    </button>
                                    <button type="button" onClick={() => { setRenamingBoardId(null); setRenameDraft(""); }} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50">
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <p className="truncate text-sm font-medium text-slate-900">{board.boardName}</p>
                                  <p className="mt-1 text-xs text-slate-500">Saved {formatSavedAt(board.savedAt)}</p>
                                </>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <button type="button" onClick={() => loadBoardFromCloud(board.boardId)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50">
                                Open
                              </button>
                              <button type="button" onClick={() => { setRenamingBoardId(board.boardId); setRenameDraft(board.boardName); }} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50">
                                Rename
                              </button>
                              <button type="button" onClick={() => deleteBoardFromCloud(board.boardId)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50">
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      )) : <p className="text-sm text-slate-500">No saved boards yet.</p>}
                    </div>
                  </details>

                  <details className="rounded-2xl border border-slate-200 bg-slate-50 p-3" open>
                    <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Canvas Setup</summary>
                    <div className="mt-3 space-y-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Board presets</p>
                        <div className="mt-2 grid gap-2">
                          {BOARD_PRESETS.map((preset) => (
                            <button key={preset.id} type="button" onClick={() => applyBoardPreset(preset.id)} className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-left text-sm font-medium text-slate-900 hover:bg-slate-50">
                              <span className="block">{preset.label}</span>
                              <span className="mt-1 block text-xs font-normal leading-5 text-slate-500">{preset.description}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Viewport</p>
                        <div className="mt-2 flex items-center gap-2">
                          <button type="button" onClick={() => nudgeZoom(-0.1)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50">-</button>
                          <input type="range" min={0.6} max={2.5} step={0.05} value={viewportScale} onChange={(event) => setViewportScale(Number(event.target.value))} className="w-full" />
                          <button type="button" onClick={() => nudgeZoom(0.1)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-900 hover:bg-slate-50">+</button>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-600">
                          <span>{Math.round(viewportScale * 100)}%</span>
                          <button type="button" onClick={resetViewport} className="rounded-full border border-slate-300 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50">Reset</button>
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Draw style</p>
                        <div className="mt-2 grid gap-3 sm:grid-cols-3">
                          <label className="block text-xs font-medium text-slate-700">
                            Pen color
                            <input type="color" value={penColor} onChange={(event) => setPenColor(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white p-1" />
                          </label>
                          <label className="block text-xs font-medium text-slate-700">
                            Note color
                            <input type="color" value={noteColor} onChange={(event) => setNoteColor(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-300 bg-white p-1" />
                          </label>
                          <label className="block text-xs font-medium text-slate-700">
                            Pen width
                            <input type="range" min={1} max={12} value={penWidth} onChange={(event) => setPenWidth(Number(event.target.value))} className="mt-3 w-full" />
                            <span className="mt-1 block text-xs text-slate-500">{penWidth}px</span>
                          </label>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {NOTE_COLOR_SWATCHES.map((color) => (
                            <button
                              key={color}
                              type="button"
                              title={`Use note color ${color}`}
                              onClick={() => setNoteColor(color)}
                              className={noteColor === color
                                ? "h-7 w-7 rounded-full ring-2 ring-slate-950 ring-offset-2"
                                : "h-7 w-7 rounded-full ring-1 ring-slate-200"
                              }
                              style={{ backgroundColor: color }}
                            />
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Assets</p>
                        <label className="mt-2 block text-xs font-medium text-slate-700">
                          Source overlay
                          <input type="file" accept="image/*,.pdf" onChange={handleSourceAttachment} className="mt-2 block w-full text-xs text-slate-600" />
                        </label>
                        <label className="mt-3 block text-xs font-medium text-slate-700">
                          Add image to board
                          <input type="file" accept="image/*" onChange={handleBoardImageAttachment} className="mt-2 block w-full text-xs text-slate-600" />
                          <span className="mt-2 block text-[11px] text-slate-500">Paste copied images with Ctrl+V or use the AI image action in Workspace Copilot.</span>
                        </label>
                        {sourceAttachmentName ? (
                          <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs text-slate-600">
                            {sourceAttachmentName}
                            {sourceOverlayKind === "pdf" ? ` • page ${pdfCurrentPage} of ${pdfPageCount}` : ""}
                          </div>
                        ) : null}
                        {sourceOverlayKind === "pdf" ? (
                          <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs text-slate-600">
                            <div className="flex items-center justify-between gap-2">
                              <button type="button" onClick={() => void goToPdfPage(pdfCurrentPage - 1)} disabled={pdfLoading || pdfCurrentPage <= 1} className="rounded-full border border-slate-300 px-3 py-1 font-medium text-slate-700 disabled:opacity-50">
                                Prev
                              </button>
                              <span>{pdfLoading ? "Rendering..." : `Page ${pdfCurrentPage} / ${pdfPageCount}`}</span>
                              <button type="button" onClick={() => void goToPdfPage(pdfCurrentPage + 1)} disabled={pdfLoading || pdfCurrentPage >= pdfPageCount} className="rounded-full border border-slate-300 px-3 py-1 font-medium text-slate-700 disabled:opacity-50">
                                Next
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </details>
                </div>
              </div>
            </aside>
          ) : null}

          <div ref={boardViewportRef} className={isCompactViewport ? "relative min-h-[72vh] overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white shadow-inner" : "relative min-h-[78vh] overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white shadow-inner"}>
            <div className="absolute left-0 top-0" style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: boardTransform, transformOrigin: "top left" }}>
              {sourceAttachmentUrl && (sourceOverlayKind === "image" || sourceOverlayKind === "pdf") ? (
                <img src={sourceAttachmentUrl} alt="workspace source overlay" className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-25" />
              ) : null}

              {boardImages.map((image) => (
                <img
                  key={image.id}
                  src={image.src}
                  alt={image.name}
                  className="pointer-events-none absolute rounded-2xl border border-slate-200 bg-white/70 object-contain shadow-sm"
                  style={{ left: image.x, top: image.y, width: image.width, height: image.height }}
                />
              ))}

              {shapes.map((shape) => {
                if (shape.kind !== "rectangle") return null;
                const selected = selectedShapeIds.includes(shape.id);
                return (
                  <div
                    key={shape.id}
                    className={selected
                      ? "absolute rounded-2xl border-2 border-sky-500 bg-white/10 shadow-sm"
                      : "absolute rounded-2xl border border-slate-300 bg-white/10 shadow-sm"
                    }
                    style={{ left: shape.x, top: shape.y, width: shape.width, minHeight: shape.height }}
                    onPointerDown={(event) => handleRectangleFramePointerDown(shape.id, event)}
                  >
                    <div className="pointer-events-none px-3 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Frame
                    </div>
                    <textarea
                      value={shape.text}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        selectShape(shape.id, event.shiftKey);
                      }}
                      onFocus={() => selectShape(shape.id, false)}
                      onChange={(event) => updateRectangleText(shape.id, event.target.value)}
                      placeholder="Type inside the box"
                      className="w-full resize-none bg-transparent px-3 pb-3 pt-2 text-sm leading-6 text-slate-900 outline-none"
                      style={{ minHeight: Math.max(32, shape.height - 28) }}
                    />
                  </div>
                );
              })}

              <canvas
                ref={canvasRef}
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                className="absolute inset-0 h-full w-full touch-none bg-white"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerAction}
                onPointerCancel={finishPointerAction}
              />

              <svg viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} className="absolute inset-0 h-full w-full pointer-events-none">
                {selectedStrokeIds.map((strokeId) => {
                  const stroke = strokes.find((item) => item.id === strokeId);
                  if (!stroke) return null;
                  const bounds = getStrokeBounds(stroke);
                  return (
                    <rect
                      key={`stroke-selection-${strokeId}`}
                      x={Math.max(0, bounds.x - 8)}
                      y={Math.max(0, bounds.y - 8)}
                      width={Math.max(16, bounds.width + 16)}
                      height={Math.max(16, bounds.height + 16)}
                      fill="rgba(14,165,233,0.06)"
                      stroke="#0284c7"
                      strokeDasharray="8 6"
                      strokeWidth={2}
                    />
                  );
                })}
                {selectedImageIds.map((imageId) => {
                  const image = boardImages.find((item) => item.id === imageId);
                  if (!image) return null;
                  return (
                    <rect
                      key={`image-selection-${imageId}`}
                      x={Math.max(0, image.x - 8)}
                      y={Math.max(0, image.y - 8)}
                      width={Math.max(16, image.width + 16)}
                      height={Math.max(16, image.height + 16)}
                      rx={20}
                      fill="rgba(14,165,233,0.06)"
                      stroke="#0284c7"
                      strokeDasharray="8 6"
                      strokeWidth={2}
                    />
                  );
                })}
                {shapes.filter((shape) => shape.kind === "arrow").map((shape) => renderBoardShape(shape, selectedShapeIds.includes(shape.id), canManipulateSelection, handleShapePointerDown))}
                {draftShape ? renderDraftShape(draftShape, penColor) : null}
                {selectionBoxRect ? (
                  <rect
                    x={selectionBoxRect.x}
                    y={selectionBoxRect.y}
                    width={selectionBoxRect.width}
                    height={selectionBoxRect.height}
                    fill="rgba(14,165,233,0.08)"
                    stroke="#0284c7"
                    strokeDasharray="8 6"
                    strokeWidth={2}
                  />
                ) : null}
                {assistSuggestion && showOverlayGuide
                  ? assistSuggestion.connections.map((connection) => {
                      const from = assistSuggestion.nodes.find((node) => node.id === connection.from);
                      const to = assistSuggestion.nodes.find((node) => node.id === connection.to);
                      if (!from || !to) return null;
                      return (
                        <g key={`${connection.from}-${connection.to}-${connection.label}`}>
                          <line x1={from.x * CANVAS_WIDTH} y1={from.y * CANVAS_HEIGHT} x2={to.x * CANVAS_WIDTH} y2={to.y * CANVAS_HEIGHT} stroke="#0ea5e9" strokeDasharray="8 8" strokeWidth="2" />
                          <text x={((from.x + to.x) / 2) * CANVAS_WIDTH} y={((from.y + to.y) / 2) * CANVAS_HEIGHT - 8} fontSize="14" textAnchor="middle" fill="#0369a1">
                            {connection.label}
                          </text>
                        </g>
                      );
                    })
                  : null}
                {assistSuggestion && showOverlayGuide
                  ? assistSuggestion.nodes.map((node) => (
                      <g key={node.id} transform={`translate(${node.x * CANVAS_WIDTH}, ${node.y * CANVAS_HEIGHT})`}>
                        <rect x={-86} y={-24} width={172} height={48} rx={18} fill="rgba(14,165,233,0.14)" stroke="#0284c7" strokeDasharray="8 5" />
                        <text textAnchor="middle" y="6" fontSize="15" fill="#0f172a">{node.label}</text>
                      </g>
                    ))
                  : null}
                {canManipulateSelection && shapes.map((shape) => {
                  if (!selectedShapeIds.includes(shape.id)) return null;
                  if (shape.kind === "rectangle") {
                    return renderRectangleHandles(shape, startRectangleResize);
                  }
                  return renderArrowHandles(shape, startArrowHandleDrag);
                })}
                {canManipulateSelection && boardImages.map((image) => selectedImageIds.includes(image.id) ? renderImageHandles(image, startImageResize) : null)}
              </svg>

              {notes.map((note) => {
                const selected = selectedNoteIds.includes(note.id);
                return (
                  <div
                    key={note.id}
                    className={selected ? "absolute rounded-2xl border-2 border-sky-500 shadow-sm" : "absolute rounded-2xl border border-amber-200 shadow-sm"}
                    style={{ left: note.x, top: note.y, width: note.width, minHeight: note.height, backgroundColor: note.color }}
                    onPointerDown={(event) => handleNoteBodyPointerDown(note.id, event)}
                  >
                    <div
                      className="flex cursor-grab items-center justify-between rounded-t-2xl border-b border-amber-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-900"
                      onPointerDown={(event) => handleNoteHeaderPointerDown(note.id, event)}
                    >
                      <span>Note</span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setNotes((current) => current.filter((item) => item.id !== note.id));
                          setSelectedNoteIds((current) => current.filter((item) => item !== note.id));
                        }}
                        className="pointer-events-auto rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700"
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      value={note.text}
                      onChange={(event) => updateNoteText(note.id, event.target.value)}
                      className="w-full resize-none rounded-b-2xl bg-transparent px-3 py-3 text-sm leading-6 text-slate-900 outline-none"
                      style={{ minHeight: note.height - 40 }}
                    />
                    {selected && canManipulateSelection ? renderNoteHandles(note, startNoteResize) : null}
                  </div>
                );
              })}
            </div>

            {showCopilot ? (
              <div className={isCompactViewport
                ? "absolute inset-x-3 bottom-20 z-20 overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white/97 shadow-xl backdrop-blur"
                : "absolute bottom-4 right-4 top-20 z-20 w-full max-w-[320px] overflow-hidden rounded-[1.75rem] border border-slate-200 bg-white/95 shadow-xl backdrop-blur md:bottom-6 md:right-6"
              }>
                <div className="flex h-full flex-col">
                <div className="flex items-center justify-between gap-3">
                  <div className="px-4 pt-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-700">Workspace Copilot</p>
                    <p className="mt-1 text-sm text-slate-600">Ambient board intelligence, continuity memory, and actions for this workspace.</p>
                  </div>
                  <button type="button" onClick={() => setShowCopilot(false)} className="mr-4 mt-4 rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                    Hide
                  </button>
                </div>

                <div className={isCompactViewport ? "max-h-[60vh] flex-1 space-y-4 overflow-y-auto px-4 pb-4" : "flex-1 space-y-4 overflow-y-auto px-4 pb-4"}>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">AI observations</p>
                    <div className="mt-3 space-y-2">
                      {copilotObservations.map((observation) => (
                        <div key={observation} className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-700">
                          {observation}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Workspace memory</p>
                      <button type="button" onClick={() => window.location.assign(workspaceChatHref)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                        Open chat
                      </button>
                    </div>
                    <div className="mt-3 space-y-2">
                      {workspaceMemory.length ? workspaceMemory.map((item) => (
                        <div key={item} className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-700">
                          {item}
                        </div>
                      )) : (
                        <div className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-700">
                          Copilot will start building continuity memory as you sketch, annotate, and use workspace chat.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Quick actions</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {[
                        ["clean-sketch", "Clean layout"],
                        ["flowchart", inferredTaskCount >= 2 ? "Build timeline" : "Convert to flowchart"],
                        ["relationships", "Map relationships"],
                        ["visualize", "Visualize structure"],
                      ].map(([intent, label]) => (
                        <button
                          key={intent}
                          type="button"
                          onClick={() => requestAssist(intent as WhiteboardAssistIntent)}
                          disabled={assistLoading !== null}
                          className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-950 hover:bg-cyan-100 disabled:opacity-60"
                        >
                          {assistLoading === intent ? "Thinking..." : label}
                        </button>
                      ))}
                    </div>
                    <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Canvas focus
                      <input
                        value={workspaceGoal}
                        onChange={(event) => setWorkspaceGoal(event.target.value)}
                        placeholder="What are you trying to map, explain, or plan?"
                        className="mt-2 w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-slate-900"
                      />
                    </label>
                    <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                      Note or AI prompt
                      <textarea
                        value={annotationDraft}
                        onChange={(event) => setAnnotationDraft(event.target.value)}
                        placeholder="Drop a note, capture a blocker, ask Copilot what structure belongs here, or describe an image to generate onto the board."
                        className="mt-2 min-h-[88px] w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-slate-900"
                      />
                    </label>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={addStickyNoteFromDraft} className="rounded-full bg-slate-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
                        Place note
                      </button>
                      <button type="button" onClick={() => void generateBoardImageFromPrompt()} disabled={imagePromptLoading} className="rounded-full border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-sm font-medium text-cyan-950 hover:bg-cyan-100 disabled:opacity-60">
                        {imagePromptLoading ? "Generating image..." : "Ask AI for image"}
                      </button>
                      <button type="button" onClick={addAnnotation} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50">
                        Save annotation
                      </button>
                      {selectedCount ? (
                        <button type="button" onClick={removeSelectedItems} className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50">
                          Delete selection
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {assistSuggestion ? (
                    <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-950">{assistSuggestion.title}</p>
                        <button type="button" onClick={applyAssistSuggestion} className="rounded-full border border-cyan-300 bg-white px-3 py-1 text-xs font-medium text-slate-900 hover:bg-cyan-100">
                          Apply
                        </button>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-slate-700">{assistSuggestion.summary}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => setShowOverlayGuide((current) => !current)} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-900 hover:bg-white">
                          {showOverlayGuide ? "Hide guide" : "Show guide"}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {recentActivity.length ? (
                    <details className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Recent activity</summary>
                      <div className="mt-3 space-y-2">
                        {recentActivity.map((item) => (
                          <div key={`${item.createdAt}-${item.content}`} className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-700">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{item.role === "assistant" ? "Mate-E" : "You"} • {formatSavedAt(item.createdAt)}</p>
                            <p className="mt-1">{truncateText(item.content, 140)}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {annotations.length ? (
                    <details className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Saved notes</summary>
                      <div className="mt-3 space-y-2">
                        {annotations.map((annotation) => (
                          <div key={annotation} className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700">
                            {annotation}
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowCopilot(true)} className={isCompactViewport
                ? "absolute bottom-24 right-3 z-20 rounded-full border border-cyan-300 bg-white/95 px-4 py-2 text-sm font-medium text-cyan-950 shadow-lg backdrop-blur hover:bg-white"
                : "absolute bottom-4 right-4 z-20 rounded-full border border-cyan-300 bg-white/90 px-4 py-2 text-sm font-medium text-cyan-950 shadow-lg backdrop-blur hover:bg-white md:bottom-6 md:right-6"
              }>
                Open Workspace Copilot
              </button>
            )}

            <div className={isCompactViewport
              ? "absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-7rem)] -translate-x-1/2 flex-wrap justify-center gap-2"
              : "absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 flex-wrap justify-center gap-2 md:bottom-6"
            }>
              <div className="rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm backdrop-blur">
                {Math.round(viewportScale * 100)}%
              </div>
              {sourceAttachmentName ? (
                <div className="rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm backdrop-blur">
                  {sourceAttachmentName}
                </div>
              ) : null}
              <div className="rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm backdrop-blur">
                {boardSummary}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function getBoardPoint(
  clientX: number,
  clientY: number,
  viewport: HTMLDivElement | null,
  offset: { x: number; y: number },
  scale: number
) {
  if (!viewport) return null;
  const rect = viewport.getBoundingClientRect();
  return {
    x: clamp((clientX - rect.left - offset.x) / scale, 0, CANVAS_WIDTH),
    y: clamp((clientY - rect.top - offset.y) / scale, 0, CANVAS_HEIGHT),
  };
}

function renderBoardShape(
  shape: BoardShape,
  selected: boolean,
  interactive: boolean,
  onPointerDown: (shapeId: string, event: React.PointerEvent<SVGElement>) => void
) {
  const strokeWidth = selected ? 4 : 3;
  if (shape.kind === "rectangle") {
    return (
      <rect
        key={shape.id}
        x={shape.x}
        y={shape.y}
        width={shape.width}
        height={shape.height}
        rx={18}
        fill="transparent"
        stroke={shape.color}
        strokeDasharray={selected ? "10 6" : undefined}
        strokeWidth={strokeWidth}
        pointerEvents={interactive ? "auto" : "none"}
        onPointerDown={(event) => onPointerDown(shape.id, event)}
      />
    );
  }

  return (
    <g key={shape.id} pointerEvents={interactive ? "auto" : "none"} onPointerDown={(event) => onPointerDown(shape.id, event)}>
      <line x1={shape.start.x} y1={shape.start.y} x2={shape.end.x} y2={shape.end.y} stroke={shape.color} strokeWidth={strokeWidth} strokeDasharray={selected ? "10 6" : undefined} />
      {renderArrowHead(shape)}
    </g>
  );
}

function renderDraftShape(draftShape: DraftShape, color: string) {
  const shape = toBoardShape(draftShape, color);
  return shape ? renderBoardShape(shape, false, false, () => undefined) : null;
}

function renderRectangleHandles(shape: BoardRectangle, onStartResize: (shape: BoardRectangle, handle: ResizeHandle, event: React.PointerEvent<SVGCircleElement>) => void) {
  const handles: Array<{ handle: ResizeHandle; x: number; y: number }> = [
    { handle: "nw", x: shape.x, y: shape.y },
    { handle: "ne", x: shape.x + shape.width, y: shape.y },
    { handle: "sw", x: shape.x, y: shape.y + shape.height },
    { handle: "se", x: shape.x + shape.width, y: shape.y + shape.height },
  ];
  return handles.map((item) => (
    <circle
      key={`${shape.id}-${item.handle}`}
      cx={item.x}
      cy={item.y}
      r={7}
      fill="#ffffff"
      stroke="#0284c7"
      strokeWidth={2}
      pointerEvents="auto"
      onPointerDown={(event) => onStartResize(shape, item.handle, event)}
    />
  ));
}

function renderArrowHandles(shape: BoardArrow, onStartDrag: (shape: BoardArrow, edge: "start" | "end", event: React.PointerEvent<SVGCircleElement>) => void) {
  return [
    <circle
      key={`${shape.id}-start`}
      cx={shape.start.x}
      cy={shape.start.y}
      r={7}
      fill="#ffffff"
      stroke="#0284c7"
      strokeWidth={2}
      pointerEvents="auto"
      onPointerDown={(event) => onStartDrag(shape, "start", event)}
    />,
    <circle
      key={`${shape.id}-end`}
      cx={shape.end.x}
      cy={shape.end.y}
      r={7}
      fill="#ffffff"
      stroke="#0284c7"
      strokeWidth={2}
      pointerEvents="auto"
      onPointerDown={(event) => onStartDrag(shape, "end", event)}
    />,
  ];
}

function renderNoteHandles(note: BoardNote, onStartResize: (note: BoardNote, handle: ResizeHandle, event: React.PointerEvent<HTMLButtonElement>) => void) {
  const positions: Array<{ handle: ResizeHandle; className: string }> = [
    { handle: "nw", className: "left-[-6px] top-[-6px] cursor-nwse-resize" },
    { handle: "ne", className: "right-[-6px] top-[-6px] cursor-nesw-resize" },
    { handle: "sw", className: "bottom-[-6px] left-[-6px] cursor-nesw-resize" },
    { handle: "se", className: "bottom-[-6px] right-[-6px] cursor-nwse-resize" },
  ];
  return positions.map((item) => (
    <button
      key={`${note.id}-${item.handle}`}
      type="button"
      aria-label={`Resize note ${item.handle}`}
      onPointerDown={(event) => onStartResize(note, item.handle, event)}
      className={`absolute h-3.5 w-3.5 rounded-full border-2 border-sky-500 bg-white ${item.className}`}
    />
  ));
}

function renderArrowHead(shape: BoardArrow) {
  return <polygon points={getArrowHeadPoints(shape)} fill={shape.color} />;
}

function getArrowHeadPoints(shape: BoardArrow) {
  const angle = Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x);
  const size = 12;
  const left = {
    x: shape.end.x - size * Math.cos(angle - Math.PI / 6),
    y: shape.end.y - size * Math.sin(angle - Math.PI / 6),
  };
  const right = {
    x: shape.end.x - size * Math.cos(angle + Math.PI / 6),
    y: shape.end.y - size * Math.sin(angle + Math.PI / 6),
  };

  return `${round2(shape.end.x)},${round2(shape.end.y)} ${round2(left.x)},${round2(left.y)} ${round2(right.x)},${round2(right.y)}`;
}

function toBoardShape(draftShape: DraftShape, color: string): BoardShape | null {
  if (draftShape.kind === "rectangle") {
    const width = Math.abs(draftShape.current.x - draftShape.start.x);
    const height = Math.abs(draftShape.current.y - draftShape.start.y);
    if (width < 8 || height < 8) return null;
    return {
      id: `rect-${Date.now()}`,
      kind: "rectangle",
      x: Math.min(draftShape.start.x, draftShape.current.x),
      y: Math.min(draftShape.start.y, draftShape.current.y),
      width,
      height,
      color,
      text: "",
    };
  }

  const length = Math.hypot(draftShape.current.x - draftShape.start.x, draftShape.current.y - draftShape.start.y);
  if (length < 10) return null;
  return {
    id: `arrow-${Date.now()}`,
    kind: "arrow",
    start: draftShape.start,
    end: draftShape.current,
    color,
  };
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke) {
  if (!stroke.points.length) return;

  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
}

async function renderBoardSnapshot({
  sourceAttachmentUrl,
  strokes,
  shapes,
  notes,
  images,
  mimeType = "image/png",
  quality,
}: {
  sourceAttachmentUrl: string | null;
  strokes: Stroke[];
  shapes: BoardShape[];
  notes: BoardNote[];
  images: BoardImage[];
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
  quality?: number;
}) {
  const canvas = window.document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  if (sourceAttachmentUrl) {
    const image = await loadImage(sourceAttachmentUrl);
    context.save();
    context.globalAlpha = 0.3;
    drawContainedImage(context, image, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.restore();
  }

  for (const boardImage of images) {
    const image = await loadImage(boardImage.src);
    context.drawImage(image, boardImage.x, boardImage.y, boardImage.width, boardImage.height);
  }

  for (const stroke of strokes) drawStroke(context, stroke);
  for (const shape of shapes) drawShapeOnCanvas(context, shape);
  for (const note of notes) drawNoteOnCanvas(context, note);

  return canvas.toDataURL(mimeType, quality);
}

function renderBoardSvg({
  sourceAttachmentUrl,
  strokes,
  shapes,
  notes,
  images,
}: {
  sourceAttachmentUrl: string | null;
  strokes: Stroke[];
  shapes: BoardShape[];
  notes: BoardNote[];
  images: BoardImage[];
}) {
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}">`,
    `<rect width="100%" height="100%" fill="#ffffff" />`,
  ];

  if (sourceAttachmentUrl?.startsWith("data:")) {
    parts.push(`<image href="${escapeAttribute(sourceAttachmentUrl)}" x="0" y="0" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" opacity="0.3" preserveAspectRatio="xMidYMid meet" />`);
  }

  for (const image of images) {
    parts.push(`<image href="${escapeAttribute(image.src)}" x="${round2(image.x)}" y="${round2(image.y)}" width="${round2(image.width)}" height="${round2(image.height)}" preserveAspectRatio="xMidYMid meet" />`);
  }

  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const path = stroke.points.map((point, index) => `${index === 0 ? "M" : "L"} ${round2(point.x)} ${round2(point.y)}`).join(" ");
    parts.push(`<path d="${path}" fill="none" stroke="${escapeAttribute(stroke.color)}" stroke-width="${round2(stroke.width)}" stroke-linecap="round" stroke-linejoin="round" />`);
  }

  for (const shape of shapes) {
    if (shape.kind === "rectangle") {
      parts.push(`<rect x="${round2(shape.x)}" y="${round2(shape.y)}" width="${round2(shape.width)}" height="${round2(shape.height)}" rx="18" fill="none" stroke="${escapeAttribute(shape.color)}" stroke-width="3" />`);
      const textLines = wrapSvgText(shape.text || "", Math.max(80, shape.width - 24), Math.max(2, Math.floor((shape.height - 36) / 22)));
      textLines.forEach((line, index) => {
        parts.push(`<text x="${round2(shape.x + 12)}" y="${round2(shape.y + 34 + index * 22)}" font-family="Aptos, sans-serif" font-size="15" fill="#0F172A">${escapeText(line)}</text>`);
      });
      continue;
    }

    parts.push(`<line x1="${round2(shape.start.x)}" y1="${round2(shape.start.y)}" x2="${round2(shape.end.x)}" y2="${round2(shape.end.y)}" stroke="${escapeAttribute(shape.color)}" stroke-width="3" />`);
    parts.push(`<polygon points="${getArrowHeadPoints(shape)}" fill="${escapeAttribute(shape.color)}" />`);
  }

  for (const note of notes) {
    parts.push(`<rect x="${round2(note.x)}" y="${round2(note.y)}" width="${round2(note.width)}" height="${round2(note.height)}" rx="18" fill="${escapeAttribute(note.color)}" stroke="#D97706" stroke-width="1.2" />`);
    const textLines = wrapSvgText(note.text, Math.max(80, note.width - 24), Math.max(2, Math.floor((note.height - 30) / 22)));
    textLines.forEach((line, index) => {
      parts.push(`<text x="${round2(note.x + 12)}" y="${round2(note.y + 26 + index * 22)}" font-family="Aptos, sans-serif" font-size="15" fill="#0F172A">${escapeText(line)}</text>`);
    });
  }

  parts.push(`</svg>`);
  return parts.join("");
}

function drawShapeOnCanvas(context: CanvasRenderingContext2D, shape: BoardShape) {
  context.strokeStyle = shape.color;
  context.fillStyle = shape.color;
  context.lineWidth = 3;

  if (shape.kind === "rectangle") {
    context.beginPath();
    context.roundRect(shape.x, shape.y, shape.width, shape.height, 18);
    context.stroke();
    context.fillStyle = "#0F172A";
    context.font = '15px "Aptos", sans-serif';
    wrapText(context, shape.text || "", shape.x + 12, shape.y + 34, Math.max(80, shape.width - 24), 22, Math.max(2, Math.floor((shape.height - 36) / 22)));
    return;
  }

  context.beginPath();
  context.moveTo(shape.start.x, shape.start.y);
  context.lineTo(shape.end.x, shape.end.y);
  context.stroke();

  const angle = Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x);
  const size = 12;
  context.beginPath();
  context.moveTo(shape.end.x, shape.end.y);
  context.lineTo(shape.end.x - size * Math.cos(angle - Math.PI / 6), shape.end.y - size * Math.sin(angle - Math.PI / 6));
  context.lineTo(shape.end.x - size * Math.cos(angle + Math.PI / 6), shape.end.y - size * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fill();
}

function drawNoteOnCanvas(context: CanvasRenderingContext2D, note: BoardNote) {
  context.fillStyle = note.color;
  context.strokeStyle = "#D97706";
  context.lineWidth = 1.2;
  context.beginPath();
  context.roundRect(note.x, note.y, note.width, note.height, 18);
  context.fill();
  context.stroke();

  context.fillStyle = "#0F172A";
  context.font = '15px "Aptos", sans-serif';
  wrapText(context, note.text, note.x + 12, note.y + 26, Math.max(80, note.width - 24), 22, Math.max(2, Math.floor((note.height - 30) / 22)));
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
) {
  const words = text.split(/\s+/).filter(Boolean);
  let line = "";
  let lineIndex = 0;

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width > maxWidth && line) {
      context.fillText(line, x, y + lineIndex * lineHeight);
      line = word;
      lineIndex += 1;
      if (lineIndex >= maxLines) break;
    } else {
      line = next;
    }
  }

  if (lineIndex < maxLines && line) {
    context.fillText(line, x, y + lineIndex * lineHeight);
  }
}

function drawContainedImage(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;
  context.drawImage(image, x, y, drawWidth, drawHeight);
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image failed to load"));
    image.src = src;
  });
}

function createStrokeId() {
  return `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitStrokeByEraser(stroke: Stroke, point: StrokePoint, tolerance: number) {
  if (!stroke.points.length) return [];

  const segments: Stroke[] = [];
  let currentPoints: StrokePoint[] = [];

  for (const strokePoint of stroke.points) {
    const shouldErasePoint = Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= tolerance;
    if (shouldErasePoint) {
      if (currentPoints.length >= 2) {
        segments.push({
          ...stroke,
          id: createStrokeId(),
          points: currentPoints,
        });
      }
      currentPoints = [];
      continue;
    }

    currentPoints = [...currentPoints, strokePoint];
  }

  if (currentPoints.length >= 2) {
    segments.push({
      ...stroke,
      id: createStrokeId(),
      points: currentPoints,
    });
  }

  if (!segments.length && !stroke.points.some((strokePoint) => Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= tolerance)) {
    return [stroke];
  }

  return segments;
}

function createNote(text: string, x: number, y: number, color: string, width = DEFAULT_NOTE_WIDTH, height = DEFAULT_NOTE_HEIGHT): BoardNote {
  return {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    x,
    y,
    width,
    height,
    text,
    color,
  };
}

function createArrow(start: StrokePoint, end: StrokePoint, color = "#0284C7"): BoardArrow {
  return {
    id: `arrow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "arrow",
    start,
    end,
    color,
  };
}

function createEmptySnapshot(): PersistedWhiteboardState {
  return {
    strokes: [],
    shapes: [],
    notes: [],
    images: [],
    annotations: [],
    workspaceGoal: "",
    toolMode: "select",
    viewportScale: 1,
    viewportOffset: { x: 0, y: 0 },
  };
}

function resizeBox(
  origin: { x: number; y: number; width: number; height: number },
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
  minWidth: number,
  minHeight: number
) {
  let left = origin.x;
  let right = origin.x + origin.width;
  let top = origin.y;
  let bottom = origin.y + origin.height;

  if (handle === "nw" || handle === "sw") left += deltaX;
  if (handle === "ne" || handle === "se") right += deltaX;
  if (handle === "nw" || handle === "ne") top += deltaY;
  if (handle === "sw" || handle === "se") bottom += deltaY;

  const normalizedLeft = Math.min(left, right);
  const normalizedRight = Math.max(left, right);
  const normalizedTop = Math.min(top, bottom);
  const normalizedBottom = Math.max(top, bottom);

  left = normalizedLeft;
  right = normalizedRight;
  top = normalizedTop;
  bottom = normalizedBottom;

  if (right - left < minWidth) {
    right = left + minWidth;
  }

  if (bottom - top < minHeight) {
    bottom = top + minHeight;
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function clampRectToBoard(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: clamp(rect.x, 0, CANVAS_WIDTH - rect.width),
    y: clamp(rect.y, 0, CANVAS_HEIGHT - rect.height),
    width: clamp(rect.width, 1, CANVAS_WIDTH),
    height: clamp(rect.height, 1, CANVAS_HEIGHT),
  };
}

function findBoardImageAtPoint(images: BoardImage[], point: StrokePoint) {
  return [...images].reverse().find((image) => pointInRect(point, { x: image.x, y: image.y, width: image.width, height: image.height })) ?? null;
}

function toggleId(current: string[], id: string, multi: boolean) {
  if (!multi) return [id];
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

function unionIds(a: string[], b: string[]) {
  return Array.from(new Set([...a, ...b]));
}

function normalizeSelectionBox(box: SelectionBox) {
  return {
    x: Math.min(box.start.x, box.current.x),
    y: Math.min(box.start.y, box.current.y),
    width: Math.abs(box.current.x - box.start.x),
    height: Math.abs(box.current.y - box.start.y),
  };
}

function getStrokeBounds(stroke: Stroke) {
  if (!stroke.points.length) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const xs = stroke.points.map((point) => point.x);
  const ys = stroke.points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function findStrokeAtPoint(strokes: Stroke[], point: StrokePoint) {
  return [...strokes].reverse().find((stroke) => {
    const bounds = getStrokeBounds(stroke);
    const padding = Math.max(8, stroke.width * 2);
    return point.x >= bounds.x - padding
      && point.x <= bounds.x + bounds.width + padding
      && point.y >= bounds.y - padding
      && point.y <= bounds.y + bounds.height + padding;
  }) ?? null;
}

function isPointNearStroke(stroke: Stroke, point: StrokePoint, tolerance: number) {
  if (!stroke.points.length) return false;
  if (stroke.points.length === 1) {
    return Math.hypot(stroke.points[0].x - point.x, stroke.points[0].y - point.y) <= tolerance;
  }

  for (let index = 1; index < stroke.points.length; index += 1) {
    if (distancePointToSegment(point, stroke.points[index - 1], stroke.points[index]) <= tolerance) {
      return true;
    }
  }

  return false;
}

function getShapeBounds(shape: BoardShape) {
  if (shape.kind === "rectangle") {
    return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
  }
  return {
    x: Math.min(shape.start.x, shape.end.x),
    y: Math.min(shape.start.y, shape.end.y),
    width: Math.abs(shape.end.x - shape.start.x),
    height: Math.abs(shape.end.y - shape.start.y),
  };
}

function isPointNearShape(shape: BoardShape, point: StrokePoint, tolerance: number) {
  if (shape.kind === "rectangle") {
    return pointInRect(point, { x: shape.x, y: shape.y, width: shape.width, height: shape.height }, tolerance);
  }

  return distancePointToSegment(point, shape.start, shape.end) <= tolerance;
}

function pointInRect(point: StrokePoint, rect: { x: number; y: number; width: number; height: number }, padding = 0) {
  return point.x >= rect.x - padding
    && point.x <= rect.x + rect.width + padding
    && point.y >= rect.y - padding
    && point.y <= rect.y + rect.height + padding;
}

function distancePointToSegment(point: StrokePoint, start: StrokePoint, end: StrokePoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
  const projectedX = start.x + t * dx;
  const projectedY = start.y + t * dy;
  return Math.hypot(point.x - projectedX, point.y - projectedY);
}

function rectsIntersect(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function cloneSnapshot(snapshot: PersistedWhiteboardState): PersistedWhiteboardState {
  return JSON.parse(JSON.stringify(snapshot)) as PersistedWhiteboardState;
}

function serializeSnapshot(snapshot: PersistedWhiteboardState) {
  return JSON.stringify(snapshot);
}

function sanitizePersistedState(value: Partial<PersistedWhiteboardState> | null | undefined): PersistedWhiteboardState {
  return {
    strokes: Array.isArray(value?.strokes) ? (value.strokes ?? []).map(sanitizeStroke).filter(Boolean) as Stroke[] : [],
    shapes: Array.isArray(value?.shapes) ? (value.shapes ?? []).map(sanitizeShape).filter(Boolean) as BoardShape[] : [],
    notes: Array.isArray(value?.notes) ? (value.notes ?? []).map(sanitizeNote).filter(Boolean) as BoardNote[] : [],
    images: Array.isArray(value?.images) ? (value.images ?? []).map(sanitizeImage).filter(Boolean) as BoardImage[] : [],
    annotations: Array.isArray(value?.annotations) ? value.annotations.filter((item): item is string => typeof item === "string").slice(0, 8) : [],
    workspaceGoal: typeof value?.workspaceGoal === "string" ? value.workspaceGoal : "",
    toolMode: isToolMode(value?.toolMode) ? value.toolMode : "select",
    viewportScale: clamp(Number(value?.viewportScale) || 1, 0.6, 2.5),
    viewportOffset: {
      x: Number(value?.viewportOffset?.x) || 0,
      y: Number(value?.viewportOffset?.y) || 0,
    },
  };
}

function sanitizeStroke(value: unknown): Stroke | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : createStrokeId(),
    color: typeof candidate.color === "string" ? candidate.color : "#0f172a",
    width: clamp(Number(candidate.width) || 3, 1, 20),
    points: Array.isArray(candidate.points)
      ? candidate.points
          .map((point) => {
            if (!point || typeof point !== "object") return null;
            const current = point as Record<string, unknown>;
            return {
              x: clamp(Number(current.x) || 0, 0, CANVAS_WIDTH),
              y: clamp(Number(current.y) || 0, 0, CANVAS_HEIGHT),
            };
          })
          .filter(Boolean) as StrokePoint[]
      : [],
  };
}

function sanitizeShape(value: unknown): BoardShape | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "rectangle") {
    return {
      id: String(candidate.id || `rect-${Date.now()}`),
      kind: "rectangle",
      x: clamp(Number(candidate.x) || 0, 0, CANVAS_WIDTH),
      y: clamp(Number(candidate.y) || 0, 0, CANVAS_HEIGHT),
      width: clamp(Number(candidate.width) || MIN_RECT_WIDTH, MIN_RECT_WIDTH, CANVAS_WIDTH),
      height: clamp(Number(candidate.height) || MIN_RECT_HEIGHT, MIN_RECT_HEIGHT, CANVAS_HEIGHT),
      color: typeof candidate.color === "string" ? candidate.color : "#0f172a",
      text: typeof candidate.text === "string" ? candidate.text : "",
    };
  }
  if (candidate.kind === "arrow") {
    return {
      id: String(candidate.id || `arrow-${Date.now()}`),
      kind: "arrow",
      start: { x: clamp(Number((candidate.start as Record<string, unknown> | undefined)?.x) || 0, 0, CANVAS_WIDTH), y: clamp(Number((candidate.start as Record<string, unknown> | undefined)?.y) || 0, 0, CANVAS_HEIGHT) },
      end: { x: clamp(Number((candidate.end as Record<string, unknown> | undefined)?.x) || 0, 0, CANVAS_WIDTH), y: clamp(Number((candidate.end as Record<string, unknown> | undefined)?.y) || 0, 0, CANVAS_HEIGHT) },
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
    x: clamp(Number(candidate.x) || 0, 0, CANVAS_WIDTH),
    y: clamp(Number(candidate.y) || 0, 0, CANVAS_HEIGHT),
    width: clamp(Number(candidate.width) || DEFAULT_NOTE_WIDTH, MIN_NOTE_WIDTH, CANVAS_WIDTH),
    height: clamp(Number(candidate.height) || DEFAULT_NOTE_HEIGHT, MIN_NOTE_HEIGHT, CANVAS_HEIGHT),
    text: typeof candidate.text === "string" ? candidate.text : "",
    color: typeof candidate.color === "string" ? candidate.color : DEFAULT_NOTE_COLOR,
  };
}

function sanitizeImage(value: unknown): BoardImage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.src !== "string" || !candidate.src) return null;
  return {
    id: String(candidate.id || `image-${Date.now()}`),
    x: clamp(Number(candidate.x) || 0, 0, CANVAS_WIDTH),
    y: clamp(Number(candidate.y) || 0, 0, CANVAS_HEIGHT),
    width: clamp(Number(candidate.width) || DEFAULT_BOARD_IMAGE_WIDTH, MIN_BOARD_IMAGE_WIDTH, CANVAS_WIDTH),
    height: clamp(Number(candidate.height) || DEFAULT_BOARD_IMAGE_HEIGHT, MIN_BOARD_IMAGE_HEIGHT, CANVAS_HEIGHT),
    src: candidate.src,
    name: typeof candidate.name === "string" ? candidate.name : "Board image",
  };
}

function hasMeaningfulBoardContent(snapshot: PersistedWhiteboardState) {
  return Boolean(snapshot.workspaceGoal.trim() || snapshot.annotations.length || snapshot.notes.length || snapshot.images.length || snapshot.shapes.length || snapshot.strokes.length);
}

function inferTaskCount(noteTexts: string[], annotations: string[], workspaceGoal: string) {
  const checklistMatches = [...noteTexts, ...annotations, workspaceGoal]
    .join("\n")
    .match(/(^|\n)\s*(?:\[ \]|\[x\]|-|\*|\d+[.)])\s+/g);
  if (checklistMatches?.length) {
    return checklistMatches.length;
  }

  const taskLikeLines = [...noteTexts, ...annotations]
    .flatMap((entry) => entry.split(/\r?\n/))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => /^(review|ship|fix|map|plan|draft|send|call|align|deploy|update|create|prepare|investigate|resolve)\b/i.test(entry));

  return taskLikeLines.length;
}

function buildWhiteboardObservations(input: {
  noteCount: number;
  shapeCount: number;
  strokeCount: number;
  annotationCount: number;
  selectedCount: number;
  sourceAttachmentName: string | null;
  workspaceGoal: string;
  inferredTaskCount: number;
  hasAssistSuggestion: boolean;
  recentTutorInteractionCount: number;
}) {
  const observations: string[] = [];

  if (input.workspaceGoal.trim()) {
    observations.push(`This board is oriented around ${input.workspaceGoal.trim()}.`);
  }

  if (input.noteCount >= 3 && input.shapeCount === 0 && input.strokeCount < 3) {
    observations.push("Multiple idea clusters exist, but their relationships are still implicit.");
  } else if (input.shapeCount >= 2 || input.strokeCount >= 4) {
    observations.push("The canvas is starting to form a structured workflow rather than loose notes.");
  } else if (input.noteCount + input.shapeCount + input.strokeCount <= 1) {
    observations.push("The board is still early; this is a good point to choose a structure before it sprawls.");
  }

  if (input.inferredTaskCount >= 2) {
    observations.push(`${input.inferredTaskCount} likely action item${input.inferredTaskCount === 1 ? "" : "s"} detected on the board.`);
  }

  if (input.sourceAttachmentName) {
    observations.push(`A source overlay is attached, so Copilot can treat this as an annotated working document.`);
  }

  if (input.selectedCount >= 2) {
    observations.push(`${input.selectedCount} elements are selected; this is a good moment to turn them into a clearer grouped structure.`);
  }

  if (input.annotationCount >= 2) {
    observations.push("There is enough saved commentary here to extract a cleaner execution summary.");
  }

  if (input.recentTutorInteractionCount > 0) {
    observations.push("Workspace chat already has recent context, so Copilot can continue from prior reasoning instead of starting cold.");
  }

  if (input.hasAssistSuggestion) {
    observations.push("A live AI suggestion is ready to apply to the board.");
  }

  return observations.slice(0, 4).length
    ? observations.slice(0, 4)
    : ["Add a few notes or shapes and Copilot will start surfacing structure, gaps, and likely next actions."];
}

function buildWorkspaceChatHref(input: {
  boardName: string;
  workspaceGoal: string;
  inferredTaskCount: number;
  observations: string[];
}) {
  const starterPrompt = [
    `Continue this whiteboard workspace for \"${input.boardName.trim() || "Untitled board"}\".`,
    input.workspaceGoal.trim() ? `Current focus: ${input.workspaceGoal.trim()}.` : null,
    input.inferredTaskCount ? `${input.inferredTaskCount} likely action item${input.inferredTaskCount === 1 ? "" : "s"} are already visible.` : null,
    input.observations[0] ? `First observation: ${input.observations[0]}` : null,
    "Help me decide the next best structural move and what to turn into an execution plan.",
  ]
    .filter(Boolean)
    .join(" ");

  const params = new URLSearchParams({
    workspaceMode: "instructional-chat",
    starterPrompt,
    reason: "Continue the current whiteboard workspace with existing canvas context and recent board observations.",
  });

  return `/app/workspace?${params.toString()}`;
}

function truncateText(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function formatSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString();
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round2(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function isToolMode(value: unknown): value is ToolMode {
  return value === "select" || value === "draw" || value === "erase" || value === "pan" || value === "rectangle" || value === "arrow" || value === "note";
}

function renderImageHandles(image: BoardImage, onStartResize: (image: BoardImage, handle: ResizeHandle, event: React.PointerEvent<SVGCircleElement>) => void) {
  const handles: Array<{ handle: ResizeHandle; x: number; y: number }> = [
    { handle: "nw", x: image.x, y: image.y },
    { handle: "ne", x: image.x + image.width, y: image.y },
    { handle: "sw", x: image.x, y: image.y + image.height },
    { handle: "se", x: image.x + image.width, y: image.y + image.height },
  ];
  return handles.map((item) => (
    <circle
      key={`${image.id}-${item.handle}`}
      cx={item.x}
      cy={item.y}
      r={7}
      fill="#ffffff"
      stroke="#0284c7"
      strokeWidth={2}
      pointerEvents="auto"
      onPointerDown={(event) => onStartResize(image, item.handle, event)}
    />
  ));
}

function readBlobAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("We couldn't read that image file."));
    };
    reader.onerror = () => reject(new Error("We couldn't read that image file."));
    reader.readAsDataURL(file);
  });
}

function getContainedSize(sourceWidth: number, sourceHeight: number, maxWidth: number, maxHeight: number) {
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);
  const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight, 1);
  return {
    width: Math.max(MIN_BOARD_IMAGE_WIDTH, Math.round(safeWidth * scale)),
    height: Math.max(MIN_BOARD_IMAGE_HEIGHT, Math.round(safeHeight * scale)),
  };
}

function triggerDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
}

function wrapSvgText(text: string, maxWidth: number, maxLines: number) {
  const averageCharacterWidth = 8;
  const maxCharactersPerLine = Math.max(8, Math.floor(maxWidth / averageCharacterWidth));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    if (nextLine.length > maxCharactersPerLine && currentLine) {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length >= maxLines) break;
    } else {
      currentLine = nextLine;
    }
  }

  if (lines.length < maxLines && currentLine) {
    lines.push(currentLine);
  }

  return lines.slice(0, maxLines);
}

function escapeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeText(value);
}
