import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

// Public routes should include auth pages to avoid redirect loops
// You can extend this list with other public paths as needed
const isPublicRoute = createRouteMatcher([
  "/",
  "/label-review(.*)",
  "/how-adaptive-guidance-works(.*)",
  "/privacy(.*)",
  "/privacy-policy(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/label-review(.*)",
  "/api/workspace/presentation-plan(.*)",
  "/api/workspace/whiteboard-assist(.*)",
  "/api/transcribe(.*)",
  "/api/youtube/transcript(.*)",
  "/api/youtube-transcript(.*)",
]);

const hasClerkEnv = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

function withTraceHeaders(request: NextRequest) {
  const traceId = request.headers.get("x-quickstud-trace") || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

  // Propagate trace id to downstream handlers and back to the client.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-quickstud-trace", traceId);
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("x-quickstud-trace", traceId);

  return response;
}

const middleware = hasClerkEnv
  ? clerkMiddleware(async (auth, request) => {
      const response = withTraceHeaders(request);

      // Optional test bypass for CLI smoke-tests without a Clerk session.
      // Requires setting FLASHCARDS_TEST_KEY in the environment and passing header:
      //   x-flashcards-test-key: <FLASHCARDS_TEST_KEY>
      const testKey = process.env.FLASHCARDS_TEST_KEY;
      const path = request.nextUrl.pathname;
      if (
        testKey &&
        (path.startsWith("/api/flashcards") ||
          path.startsWith("/api/blob-upload-url") ||
          path.startsWith("/api/workspace/presentation-plan") ||
          path.startsWith("/api/workspace/whiteboard-assist") ||
          path.startsWith("/api/youtube-transcript") ||
          path.startsWith("/api/youtube/runpod-transcribe")) &&
        request.headers.get("x-flashcards-test-key") === testKey
      ) {
        return response;
      }

      if (!isPublicRoute(request)) {
        const { userId } = await auth();
        if (!userId) {
          const url = new URL("/", request.url);
          url.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
          return NextResponse.redirect(url);
        }
      }

      return response;
    })
  : ((request: NextRequest) => withTraceHeaders(request));

export default middleware;

export const config = {
  matcher: ["/((?!.+\\.[\\w]+$|_next).*)", "/", "/(api)(.*)"]
};
