"""Ukrainian narration with OmniVoice (Qwen3-TTS has no Ukrainian), scene by scene from one voice so the timbre stays:
scene 1 is voiced from a description, then cloned for the rest. Never clone from a Russian take: it carried
Russian pronunciation into the Ukrainian one. Weights are CC-BY-NC: non-commercial use only.
Run in the work folder. Usage: python tts_uk.py <narration json> <out_prefix> [instruct] [seed]"""
import json, os, sys, time
from pathlib import Path

HOME = Path(os.environ.get("MK_VIDEO_HOME") or Path(os.environ["LOCALAPPDATA"]) / "makarasty" / "video")
os.environ.setdefault("HF_HOME", str(HOME / "hf-cache"))
import numpy as np, soundfile as sf, torch
from omnivoice import OmniVoice

narr, prefix = sys.argv[1], sys.argv[2]
instruct = sys.argv[3] if len(sys.argv) > 3 else "male, middle-aged, low pitch"
seed = int(sys.argv[4]) if len(sys.argv) > 4 else 7
segs = json.loads(Path(narr).read_text(encoding="utf-8-sig"))
t0 = time.time()
model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
sr = model.sampling_rate
torch.manual_seed(seed)
first = np.asarray(model.generate(text=segs[0]["text"], language="uk", instruct=instruct)[0], np.float32)
prompt = model.create_voice_clone_prompt(ref_audio=(torch.from_numpy(first).unsqueeze(0), sr), ref_text=segs[0]["text"])
gap = np.zeros(int(0.45 * sr), np.float32)
parts = [first, gap]  # the designed scene 1 is the reference itself: keep it as voiced
for s in segs[1:]:
    torch.manual_seed(seed)
    parts += [np.asarray(model.generate(text=s["text"], language="uk", voice_clone_prompt=prompt)[0], np.float32), gap]
out = np.concatenate(parts[:-1])
sf.write(f"{prefix}.wav", out, sr)
print(f"uk: {len(out)/sr:.1f}s audio in {time.time()-t0:.0f}s")
