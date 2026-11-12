// Types of core.mjs for the TypeScript hook (tools/hooks/inbox.ts). Hand-written; keep in step with core.mjs.
export type Option = { label: string; description?: string; preview?: string }
export type Question = { question: string; header?: string; options?: Option[]; multiSelect?: boolean }
export type Item = {
  id: string; kind: 'ask' | 'choice' | 'card'; at: number; session: string; cwd: string; chat: string
  questions?: Question[]; ask?: string; actions?: string[]; recap?: string
  title?: string; brief?: string; background?: string; taskId?: string
  context?: string; explain?: string; host?: string; account?: string
}
export type Answer = { id: string; at: number; by: 'inbox' | 'chat'; answers?: Record<string, string>; choice?: string }
export const PUSH_AFTER_MS: number
export const TTL_MS: Record<Item['kind'], number>
export const UNANSWERED_TTL_MS: number
export function safe(s: string): string
export function itemId(session: string, toolUseId: string): string
export function ownedBy(id: string, session: string): boolean
export function clean(text: string): string
export function contextOf(messages: readonly { role: string; text: string }[], n?: number, each?: number): string
export function explainPrompt(item: Item): string
export function body(item: Item): string
export function render(item: Item, now?: number, account?: string): string
export function link(item: Item, account?: string): string
export function pushText(item: Item): string
export function toResult(item: Item, answer: Answer): { questions: Question[]; answers: Record<string, string> }
export function deliveryText(item: Item, answer: Answer): string
export function normalizeAnswer(item: Item, raw: unknown): { answers: Record<string, string> } | { choice: string }
export function expired(item: Item, now?: number, answered?: boolean): boolean
export type Report = { id: string; at: number; session: string; cwd: string; chat: string; recap?: string; excerpt?: string; error?: boolean; host?: string; account?: string }
export const QUIET_MS: number
export const MAX_MS: number
export const REPORT_TTL_MS: number
export const UNSEEN_REPORT_TTL_MS: number
export function dueReports(waiting: Report[], now?: number): boolean
export function excerptOf(answer: string): string
export function renderReports(reports: Report[], now?: number, account?: string): string
