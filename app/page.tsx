// app/page.tsx
import Image from "next/image";
import Link from "next/link";
import HomeClerkAuthControls from "@/components/HomeClerkAuthControls";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const nextTarget = normalizeNextTarget(resolvedSearchParams.next);
  const hasClerk = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  return (
    <main className="flex min-h-[calc(100vh-64px)] items-center justify-center p-6">
      <div className="mx-auto max-w-4xl text-center space-y-6">
        {/* Logo / feature image */}
        <div className="relative mx-auto h-40 w-40 sm:h-48 sm:w-48">
          <Image
            src="/logo.png"
            alt="Mate-E"
            fill
            sizes="(max-width: 640px) 160px, 192px"
            className="object-contain"
            priority
          />
        </div>

        {/* Headline + subcopy always visible */}
        <h1 className="text-3xl sm:text-5xl font-semibold">
          A calm adaptive tutor for real study sessions
        </h1>
        <p className="mx-auto max-w-2xl text-gray-600">
          Mate-E helps you study with guided review, tutoring hints, progress memory, and recovery-aware recommendations that stay understandable from one session to the next.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-gray-700">
          <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1">Guided study sessions</span>
          <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1">Tutor hints that react to your answer</span>
          <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1">Progress memory across sessions</span>
          <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1">Recovery-aware recommendations</span>
          <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1">Clear next-step explanations</span>
        </div>

        <p className="mx-auto max-w-2xl text-sm text-gray-500">
          The tutoring experience is adaptive, but its authority stays bounded. Recommendations are meant to feel useful and explainable, not opaque or over-controlling.
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/how-adaptive-guidance-works"
            className="rounded-full border border-gray-300 px-6 py-3 text-sm font-medium text-gray-800 hover:bg-gray-50"
          >
            Explore resources
          </Link>

          {hasClerk ? (
            <HomeClerkAuthControls nextTarget={nextTarget} />
          ) : (
            <Link
              href="/app"
              className="rounded-full bg-black px-6 py-3 text-sm font-medium text-white hover:opacity-90"
            >
              Open study workspace
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}

function normalizeNextTarget(value: string | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("/")) return "/app";
  if (trimmed.startsWith("//")) return "/app";
  return trimmed;
}
