"""Narration with Qwen3-TTS VoiceDesign, one call for the whole script so the voice stays the same throughout.
Run in the video's work folder. Usage: python tts.py <seed> <out_prefix> <lang ru|en> <voice key from voices.json>"""
import json, os, sys, time
from pathlib import Path

ENGINE = Path(__file__).parent
HOME = Path(os.environ.get("MK_VIDEO_HOME") or Path(os.environ["LOCALAPPDATA"]) / "makarasty" / "video")
os.environ.setdefault("HF_HOME", str(HOME / "hf-cache"))
import torch, numpy as np, soundfile as sf
from qwen_tts import Qwen3TTSModel

seed, prefix, lang, voice = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
segs = json.loads(Path(os.environ.get("NARR", f"narration.{lang}.json")).read_text(encoding="utf-8-sig"))
text = "\n\n".join(s["text"] for s in segs)
instruct = json.loads((ENGINE / "voices.json").read_text(encoding="utf-8-sig"))[voice]

t0 = time.time()
tts = Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0",
                                    dtype=torch.bfloat16, attn_implementation="sdpa")
torch.manual_seed(seed)
wavs, sr = tts.generate_voice_design(text=text, instruct=instruct, language={"ru": "Russian", "en": "English"}[lang],
                                     max_new_tokens=4096)
wav = np.asarray(wavs[0], dtype=np.float32)
sf.write(f"{prefix}.wav", wav, sr)
words = len(text.split())
print(f"tts: {len(wav)/sr:.1f}s audio, {words} words = {words / (len(wav)/sr) * 60:.0f} wpm, in {time.time()-t0:.0f}s")
