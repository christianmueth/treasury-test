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
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2021" &&
    String(error.meta?.table || "").includes("User")
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
