// Mixes a soft whoosh under every scene change and a chime on the end card into a rendered MP4 (video copied as is).
// Each hit is its own ffmpeg input: feeding one input to many filter chains punched dips into the voice.
// Run in the work folder (reads timeline.json there). Usage: node sfx.mjs <in.mp4> <out.mp4>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const lab = path.dirname(fileURLToPath(import.meta.url));
const [src, dst] = process.argv.slice(2);
const { starts, endCard } = JSON.parse(fs.readFileSync('timeline.json', 'utf8'));
const hits = [...starts.slice(1).map((t) => ({ file: 'whoosh.wav', t: t - 0.42, vol: 0.22 })), { file: 'chime.wav', t: endCard, vol: 0.3 }];
const inputs = hits.flatMap((h) => ['-i', path.join(lab, h.file)]);
const parts = hits.map((h, i) => `[${i + 1}:a]adelay=${Math.round(h.t * 1000)}:all=1,volume=${h.vol}[s${i}]`);
const mix = `[0:a]${hits.map((_, i) => `[s${i}]`).join('')}amix=inputs=${hits.length + 1}:normalize=0:duration=first[a]`;
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...inputs,
  '-filter_complex', [...parts, mix].join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', dst], { stdio: 'inherit' });
console.log(`sfx: ${hits.length} hits -> ${dst}`);
