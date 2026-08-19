import { FlatCompat } from '@eslint/eslintrc'

const compat = new FlatCompat({ baseDirectory: import.meta.dirname })

/**
 * Flat config for ESLint 9. The project had `next lint` wired in package.json
 * but no config file, so linting had never actually run — it dropped into the
 * interactive setup instead. This is the Next.js recommended rule set.
 */
export default [
  { ignores: ['.next/**', 'node_modules/**', 'prisma/migrations/**', 'public/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
]
