// Types of strings.mjs for the TypeScript hook (tools/hooks/telegram.ts). Hand-written; keep in step with strings.mjs.
export const STRINGS: Record<'en' | 'ru', Record<string, string>>
export function langOf(profileText: string | undefined): 'en' | 'ru'
export function t(lang: string | undefined, key: string, vars?: Record<string, string | number>): string
