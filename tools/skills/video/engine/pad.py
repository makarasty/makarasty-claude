"""Re-paces a narration by editing only real silence. ASR word ends are often early (a cut there chops the word's
tail), so every cut and insert is placed inside a run the audio itself shows silent (< SIL dB); no silent run, no edit.
Inside a segment a pause longer than MAX_KEEP shrinks to WITHIN; between segments it becomes BETWEEN + PAUSE[k];
the tail ends TAIL after the last audible sound. Self-check: every cut point must be silent in the source.
Usage: python pad.py in.wav in.words.json segments.json out.wav"""
import json, sys
import numpy as np, soundfile as sf

WITHIN, MAX_KEEP, BETWEEN, TAIL, XF, SIL, HOP = 0.3, 0.45, 0.55, 0.25, 0.01, -45.0, 0.01
PAUSE = {0: 0.25, 2: 0.4, 3: 0.3, 4: 0.4, 5: 0.2, 6: 0.3, 7: 0.8}  # extra hold after segment k (scene beats)

src, wordf, segf, dst = sys.argv[1:5]
wav, sr = sf.read(src, dtype="float32")
segs = json.load(open(segf, encoding="utf-8"))
words = [w for w in json.load(open(wordf, encoding="utf-8")) if w["e"] - w["s"] > 0.02 and w["s"] < segs[-1]["end"] + 0.05]

hop = int(HOP * sr)
frames = np.lib.stride_tricks.sliding_window_view(np.pad(wav, (0, 2 * hop)), 2 * hop)[::hop]
env = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)  # dB per 10 ms, 20 ms window
silent = env < SIL
T = lambda f: f * HOP

def silent_run(a, b):
    """Longest silent run (start, end in seconds) between a and b, or None."""
    best, run = None, None
    for f in range(max(0, int(a / HOP)), min(len(silent), int(b / HOP) + 1)):
        if silent[f]:
            run = (run[0], f) if run else (f, f)
            if not best or run[1] - run[0] > best[1] - best[0]: best = run
        else:
            run = None
    return (T(best[0]) + HOP, T(best[1])) if best and T(best[1]) - T(best[0]) >= 0.12 else None

edits = []  # (at, remove_seconds, insert_seconds) inside silent runs
for i in range(len(words) - 1):
    a, b = words[i]["e"], words[i + 1]["s"]
    run = silent_run(a - 0.15, b + 0.1)
    if not run: continue
    k = next((k for k in range(len(segs) - 1) if segs[k]["end"] <= b + 0.01 and segs[k + 1]["start"] >= a - 0.01), None)
    gap = run[1] - run[0]
    target = BETWEEN + PAUSE.get(k, 0) if k is not None else (WITHIN if gap > MAX_KEEP else gap)
    mid = (run[0] + run[1]) / 2
    if target < gap: edits.append((mid - (gap - target) / 2, gap - target, 0.0))
    elif target > gap: edits.append((mid, 0.0, target - gap))

# tail: keep TAIL after the last audible frame past the last word's start
last = max([f for f in range(int(words[-1]["s"] / HOP), len(env)) if not silent[f]], default=int(words[-1]["e"] / HOP))
end = min(len(wav) / sr, T(last) + HOP * 2 + TAIL)

fade = np.linspace(0, 1, int(XF * sr), dtype=np.float32)
out, pos, risky = [], 0, 0
S = lambda t: int(round(t * sr))
for at, rem, ins in sorted(edits):
    if S(at) < pos: continue
    out.append(wav[pos:S(at)])
    if ins: out.append(np.zeros(S(ins), np.float32))
    pos = S(at + rem)
    for t in (at, at + rem):  # self-check: the source must be silent where we join
        f = min(len(env) - 1, int(t / HOP))
        risky += int(env[max(0, f - 1):f + 2].max() > SIL)
    if rem and out[-1].size >= fade.size and pos + fade.size <= len(wav):  # short crossfade over the join (all silence)
        out[-1][-fade.size:] = out[-1][-fade.size:] * fade[::-1] + wav[pos:pos + fade.size] * fade
        pos += fade.size
tail = wav[pos:S(end)].copy()
n = min(len(tail), S(0.12))
if n: tail[-n:] *= np.linspace(1, 0, n, dtype=np.float32)
out.append(tail)
res = np.concatenate(out)
sf.write(dst, res, sr)
print(f"pace: {len(wav)/sr:.2f}s -> {len(res)/sr:.2f}s, {len(edits)} edits, joins over sound: {risky}, tail ends {T(last):.2f}s + {TAIL}s")
assert risky == 0, "a join landed on audible sound"
