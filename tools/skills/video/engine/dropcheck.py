"""Checks a finished MP4 kept the narration intact: compares its audio envelope with the voice track it was built from.
Where the voice is speaking (> -35 dB) the MP4 must be within 6 dB of it; a hole means the render dropped or cut audio.
Usage: python dropcheck.py <video.mp4> <voice.wav>"""
import subprocess, sys
import numpy as np

def load(path):
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert p.returncode == 0, p.stderr.decode(errors="replace")[:300]
    return np.frombuffer(p.stdout, np.float32)

def env(x):
    n = len(x) // 160
    return 20 * np.log10(np.sqrt((x[: n * 160].reshape(n, 160) ** 2).mean(axis=1)) + 1e-9)

v, ref = env(load(sys.argv[1])), env(load(sys.argv[2]))
# an encoder can shift audio by a few frames (AAC priming); align first so a shift is reported as a shift, not as holes
m = min(len(v), len(ref)) - 20
lag = max(range(-10, 11), key=lambda k: np.corrcoef(v[10 + k:10 + k + m - 10], ref[10:m])[0, 1])
print(f"lag {lag * 10} ms")
v = v[lag:] if lag > 0 else np.concatenate([np.full(-lag, -120.0), v])
n = min(len(v), len(ref))
speak = ref[:n] > -35
holes = np.where(speak & (v[:n] < ref[:n] - 6))[0]
print(f"{sys.argv[1].split(chr(92))[-1]}: video audio {len(v)/100:.1f}s, voice {len(ref)/100:.1f}s, "
      f"speech frames {speak.sum()}, frames where the video lost the voice: {len(holes)} {[round(h / 100, 2) for h in holes[:8]]}")
sys.exit(1 if len(holes) else 0)
