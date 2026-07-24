import bcrypt from 'bcryptjs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const SALT_ROUNDS = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

/** Cryptographically strong URL-safe token (for refresh tokens, email links). */
export function generateToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url')
}

/** Tokens are stored hashed — a database leak must not yield usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4
  label: 'Very weak' | 'Weak' | 'Fair' | 'Strong' | 'Excellent'
  issues: string[]
}

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  '12345678',
  'qwerty123',
  'letmein1',
  'welcome1',
  'admin123',
  'restaurant',
])

export function assessPasswordStrength(password: string): PasswordStrength {
  const issues: string[] = []
  if (password.length < 8) issues.push('Use at least 8 characters')
  if (!/[a-z]/.test(password)) issues.push('Add a lowercase letter')
  if (!/[A-Z]/.test(password)) issues.push('Add an uppercase letter')
  if (!/[0-9]/.test(password)) issues.push('Add a number')
  if (COMMON_PASSWORDS.has(password.toLowerCase())) issues.push('This password is too common')

  const bonuses = [
    password.length >= 12,
    /[^A-Za-z0-9]/.test(password),
    /[A-Z]/.test(password) && /[a-z]/.test(password),
    /[0-9]/.test(password),
  ].filter(Boolean).length

  const score = Math.max(0, Math.min(4, bonuses - issues.length + 1)) as PasswordStrength['score']
  const labels: PasswordStrength['label'][] = [
    'Very weak',
    'Weak',
    'Fair',
    'Strong',
    'Excellent',
  ]
  return { score, label: labels[score], issues }
}
