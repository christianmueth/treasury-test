import { ClerkProvider } from "@clerk/nextjs";
import { Suspense } from "react";
import "./globals.css";
import { Toaster } from "sonner";
import NavBar from "@/components/NavBar"; // <-- make sure this path exists
import TutorChatPanel from "@/components/TutorChatPanel";
import WorkspaceContextSync from "@/components/WorkspaceContextSync";

export const metadata = {
  title: "Mate-E",
  description: "Replay-governed adaptive tutoring with student-state memory, tutoring hints, and shadow-scored personalization.",
  icons: {
    icon: "/logo.ico",
    shortcut: "/logo.ico",   // used by Chromium / pinned tabs
    apple: "/logo.ico",      // Apple touch icon (fallback)
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const content = (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900">
        {!pk && (
          <div className="w-full bg-yellow-100 text-yellow-900 text-sm px-4 py-2 text-center">
            Missing NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY. Clerk cannot load in this environment.
          </div>
        )}
        <Suspense fallback={null}>
          <NavBar />
        </Suspense>
        {children}
        <Suspense fallback={null}>
          <WorkspaceContextSync />
        </Suspense>
        <Suspense fallback={null}>
          <TutorChatPanel />
        </Suspense>
        <Toaster richColors closeButton position="top-right" />
      </body>
    </html>
  );

  if (!pk) {
    return content;
  }

  return (
    <ClerkProvider publishableKey={pk}>
      {content}
    </ClerkProvider>
  );
}
