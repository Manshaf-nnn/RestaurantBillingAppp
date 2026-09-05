import { z } from 'zod'

import { imageUrlField } from '@/lib/media-url'

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .email('Enter a valid email address')
  .max(255)
  .toLowerCase()

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[a-z]/, 'Include at least one lowercase letter')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/[0-9]/, 'Include at least one number')

export const phoneSchema = z
  .string()
  .trim()
  .min(7, 'Enter a valid phone number')
  .max(20, 'Enter a valid phone number')
  .regex(/^[+]?[0-9\s()-]{7,20}$/, 'Enter a valid phone number')

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
  /**
   * Now read by `createSession` (athu.md). Unticked means a twelve-hour session
   * whose refresh cookie dies with the browser; ticked means the full lifetime.
   * For a long time this was parsed here and read by nothing.
   */
  remember: z.boolean().optional().default(true),
  /**
   * The second factor, when the account has one. A six-digit authenticator
   * code or an `XXXXX-XXXXX` recovery code — so not digit-restricted. Absent on
   * the first submission; the server answers `mfaRequired` and the form asks.
   */
  code: z.string().trim().max(16).optional(),
})
export type LoginInput = z.infer<typeof loginSchema>

export const registerSchema = z
  .object({
    restaurantName: z.string().trim().min(2, 'Restaurant name is required').max(80),
    ownerName: z.string().trim().min(2, 'Your name is required').max(80),
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    currency: z.string().length(3).default('INR'),
    // 'trial'   → instant access, 30-day free trial
    // 'request' → created as pending, waits for platform-admin approval
    mode: z.enum(['trial', 'request']).default('trial'),
    acceptTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the terms to continue' }),
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
export type RegisterInput = z.infer<typeof registerSchema>

export const forgotPasswordSchema = z.object({ email: emailSchema })
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10, 'This reset link is invalid'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  phone: phoneSchema.optional().or(z.literal('')),
  avatarUrl: imageUrlField(),
})
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
