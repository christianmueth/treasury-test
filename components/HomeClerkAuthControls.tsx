"use client";

import Link from "next/link";
import { SignInButton, SignUpButton, SignedIn, SignedOut } from "@clerk/nextjs";

export default function HomeClerkAuthControls({ nextTarget }: { nextTarget: string }) {
  return (
    <>
      <SignedOut>
        <SignUpButton
          mode="modal"
          forceRedirectUrl={nextTarget}
          signInForceRedirectUrl={nextTarget}
        >
          <button className="rounded-full bg-black px-6 py-3 text-sm font-medium text-white hover:opacity-90">
            Start guided study
          </button>
        </SignUpButton>
        <SignInButton
          mode="modal"
          forceRedirectUrl={nextTarget}
          signUpForceRedirectUrl={nextTarget}
        >
          <button className="rounded-full border border-gray-300 px-6 py-3 text-sm font-medium text-gray-800 hover:bg-gray-50">
            Sign in
          </button>
        </SignInButton>
      </SignedOut>

      <SignedIn>
        <Link
          href="/app"
          className="rounded-full bg-black px-6 py-3 text-sm font-medium text-white hover:opacity-90"
        >
          Open study workspace
        </Link>
      </SignedIn>
    </>
  );
}