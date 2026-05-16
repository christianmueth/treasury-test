import { Prisma, PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") global.prisma = prisma;

export function isMissingUserTableError(error: unknown) {
  const code = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code?: string }).code)
    : "";
  const table = String((error as { meta?: { table?: unknown } } | null)?.meta?.table || "");
  const message = String((error as { message?: unknown } | null)?.message || "");

  return (
    code === "P2021" &&
    (
      table.includes("User") ||
      /public\.User/i.test(message) ||
      /table\s+.*User\s+does not exist/i.test(message) ||
      /prisma\.user\.upsert\(\)/i.test(message)
    )
  );
}

export async function safeUpsertUser<T extends Prisma.UserSelect>(clerkUserId: string, select: T) {
  try {
    return await prisma.user.upsert({
      where: { clerkUserId },
      update: {},
      create: { clerkUserId },
      select,
    });
  } catch (error) {
    if (isMissingUserTableError(error)) {
      console.warn("[db] User table unavailable; skipping user persistence");
      return null;
    }
    throw error;
  }
}
