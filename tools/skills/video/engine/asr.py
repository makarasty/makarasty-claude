"""Word timestamps for a narration wav. Run in the work folder. Usage: python asr.py <prefix> [ru|en|uk]"""
import json, os, sys, time
from pathlib import Path

HOME = Path(os.environ.get("MK_VIDEO_HOME") or Path(os.environ["LOCALAPPDATA"]) / "makarasty" / "video")
os.environ.setdefault("HF_HOME", str(HOME / "hf-cache"))
import torch
os.add_dll_directory(str(Path(torch.__file__).parent / "lib"))  # cuBLAS/cuDNN for ctranslate2
import numpy as np, soundfile as sf, librosa
from faster_whisper import WhisperModel

prefix = sys.argv[1]; lang = sys.argv[2] if len(sys.argv) > 2 else "ru"
wav, sr = sf.read(f"{prefix}.wav", dtype="float32")
if wav.ndim > 1: wav = wav.mean(axis=1)
audio = librosa.resample(wav, orig_sr=sr, target_sr=16000)  # passing an array skips faster-whisper's av decoder

t1 = time.time()
try:
    asr = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
except Exception as e:
    print("asr on cpu:", e); asr = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
parts, _ = asr.transcribe(audio, language=lang, word_timestamps=True, beam_size=5, vad_filter=False)
words = [{"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)} for p in parts for w in p.words]
Path(f"{prefix}.words.json").write_text(json.dumps(words, ensure_ascii=False, indent=0), encoding="utf-8")
gaps = sorted(((words[i + 1]["s"] - words[i]["e"], words[i]["w"]) for i in range(len(words) - 1)), reverse=True)[:8]
print(f"asr: {len(words)} words in {time.time()-t1:.0f}s, audio {len(wav)/sr:.1f}s, last word ends {words[-1]['e']}s")
print("longest gaps:", [(round(g, 2), w) for g, w in gaps])
print("HEARD:", " ".join(w["w"] for w in words))
