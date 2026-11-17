// Types of render.mjs for the TypeScript hook (tools/hooks/telegram.ts). Hand-written; keep in step with render.mjs.
export function esc(s: string): string
export function rich(s: string, md?: boolean): string
export function phoneHtml(m: { question: string; meta: string; note?: string }): string
export function phoneKeyboard(options: string[], more?: boolean, lang?: string): { inline_keyboard: { text: string; callback_data: string }[][] }
export function collapsed(short: string, outcome: string): string
export function note(text: string): string
export function helpHtml(lang: string | undefined): string
export function ideasHtml(lang: string | undefined, lines: string[]): string
export function statusHtml(lang: string | undefined, count: number, items: { question: string; where: string; age: string }[], alive: boolean): string
export function explainHtml(lang: string | undefined, question: string, text: string | undefined): string
export function mdToTg(md: string, head?: number): string
