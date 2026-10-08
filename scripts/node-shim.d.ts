// node-shim.d.ts - the few Node built-ins the TypeScript scripts in this directory use, typed by hand.
//
// The plugin ships no package.json and no node_modules, so @types/node is not there for tsc to find. This
// declares only what fleet-analyze.ts and its test call; a script that needs more adds it here.

declare module 'node:fs' {
  export interface Stats { mtimeMs: number; size: number; isDirectory(): boolean; isFile(): boolean }
  export interface Dirent { name: string; isDirectory(): boolean; isFile(): boolean }
  export interface ReadStream { readonly path: string }
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): Stats;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function readdirSync(path: string): string[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function utimesSync(path: string, atime: Date | number, mtime: Date | number): void;
  export function createReadStream(path: string, options?: { encoding?: 'utf8' }): ReadStream;
}

declare module 'node:readline' {
  import type { ReadStream } from 'node:fs';
  export interface Interface extends AsyncIterable<string> { close(): void }
  export function createInterface(options: { input: ReadStream; crlfDelay?: number }): Interface;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export const sep: string;
}

declare module 'node:os' {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'node:child_process' {
  export interface SpawnResult { status: number | null; stdout: string; stderr: string }
  export function spawnSync(
    command: string,
    args: string[],
    options: { encoding: 'utf8'; env?: Record<string, string | undefined>; maxBuffer?: number },
  ): SpawnResult;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  execPath: string;
  exitCode: number | undefined;
  exit(code?: number): never;
  stdout: { write(s: string): boolean };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
