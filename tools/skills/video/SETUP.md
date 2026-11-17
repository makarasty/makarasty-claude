# Setting up HOME on a new machine

Needs an NVIDIA GPU, Python 3.14, Node, `ffmpeg` on PATH, and about 20 GB. HOME = `$env:MK_VIDEO_HOME`, else
`%LOCALAPPDATA%\makarasty\video`. The versions below are the ones the engine last ran with. This sequence was
assembled from a working install; it was not re-run on a clean machine.

```powershell
$H = "$env:LOCALAPPDATA\makarasty\video"; New-Item -ItemType Directory -Force "$H\node" | Out-Null
py -3.14 -m venv "$H\.venv"
& "$H\.venv\Scripts\python.exe" -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
& "$H\.venv\Scripts\python.exe" -m pip install qwen-tts==0.1.1 faster-whisper==1.2.1 librosa soundfile numpy
py -3.14 -m venv "$H\.venv-omni"
& "$H\.venv-omni\Scripts\python.exe" -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
& "$H\.venv-omni\Scripts\python.exe" -m pip install omnivoice==0.2.1 soundfile numpy
Set-Location "$H\node"; npm init -y; npm install hyperframes@0.9.61
```

Models download into `HOME\hf-cache` on first use (Qwen3-TTS VoiceDesign, OmniVoice, whisper large-v3-turbo).
`SoX could not be found` and `flash-attn is not installed` on start are harmless.
