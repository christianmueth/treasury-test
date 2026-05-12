// components/NavBar.tsx
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";

const NavBarClerkControls = dynamic(() => import("@/components/NavBarClerkControls"), {
  ssr: false,
});

export default function NavBar() {
  const hasClerk = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

  return (
    <header className="sticky top-0 z-50 bg-white/90 backdrop-blur border-b">
      <nav className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
        <Link href="/" className="font-semibold text-lg">
          Mate-E
        </Link>

        <div className="flex items-center gap-3">
          <Link href="/how-adaptive-guidance-works" className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50">
            Resources
          </Link>

          {hasClerk ? (
            <NavBarClerkControls />
          ) : (
            <Link href="/app" className="text-sm px-3 py-1.5 rounded bg-black text-white hover:opacity-90">
              Open study workspace
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
