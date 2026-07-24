import { PrismaClient, Prisma } from '@prisma/client'

/**
 * Singleton Prisma client. In development Next.js hot-reloads modules, which
 * would otherwise open a new connection pool on every edit.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
        : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export { Prisma }
export type { PrismaClient }

/** Prisma transaction client — accepted anywhere a repository takes a `tx`. */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

export type DbClient = PrismaClient | TxClient

/** Narrow a Prisma error to its known-request form. */
export function isPrismaError(
  error: unknown,
  code?: string,
): error is Prisma.PrismaClientKnownRequestError {
  const isKnown = error instanceof Prisma.PrismaClientKnownRequestError
  return code ? isKnown && (error as Prisma.PrismaClientKnownRequestError).code === code : isKnown
}

/** True when the error is a unique-constraint violation. */
export const isUniqueViolation = (error: unknown) => isPrismaError(error, 'P2002')

/** Fields involved in a unique-constraint violation, if any. */
export function uniqueViolationTargets(error: unknown): string[] {
  if (!isPrismaError(error, 'P2002')) return []
  const target = error.meta?.target
  if (Array.isArray(target)) return target as string[]
  return typeof target === 'string' ? [target] : []
}
