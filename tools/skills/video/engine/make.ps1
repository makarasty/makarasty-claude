# One video, one language: voice -> -14 LUFS -> word times (whisper) -> pauses re-paced in real silence -> word times
# -> data.js (segments, beats, captions) -> check -> MP4 -> sound effects -> dropout gate -> SRT.
# The work folder holds narration.<lang>.json and the composition (hf\index.html); the heavy parts (venvs, model cache,
# HyperFrames) live in $env:MK_VIDEO_HOME, default %LOCALAPPDATA%\makarasty\video.
param([Parameter(Mandatory)][ValidateSet('ru', 'en', 'uk')][string]$Lang, [string]$Work = (Get-Location).Path, [string]$Name = '',
      [string]$Voice = '', [int]$Seed = 7, [double]$Tempo = 1.0, [string]$Proj = '', [string]$Narr = '',
      [switch]$SkipVoice, [switch]$PrepOnly, [string]$Out = '')
$ErrorActionPreference = 'Continue'  # 5.1 turns any native stderr line into a terminating error under 'Stop'; exit codes are checked instead
$eng = $PSScriptRoot; $H = if ($env:MK_VIDEO_HOME) { $env:MK_VIDEO_HOME } else { "$env:LOCALAPPDATA\makarasty\video" }
$Work = (Resolve-Path $Work).Path; Set-Location $Work
if (-not $Name) { $Name = Split-Path $Work -Leaf }
if (-not $Proj) { $Proj = "$Work\hf" }
if (-not $Narr) { $Narr = "narration.$Lang.json" }
if (-not $Out) { $Out = Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name-$Lang.mp4" }
if (-not $Voice) { $Voice = if ($Lang -eq 'uk') { 'male, middle-aged, low pitch' } else { "calm_$Lang" } }
foreach ($need in "$H\.venv\Scripts\python.exe", "$H\node\node_modules\hyperframes\bin\hyperframes.mjs", "$Proj\index.html", $Narr) {
  if (-not (Test-Path $need)) { throw "missing $need" } }
$env:PYTHONUTF8 = '1'; $env:HF_HUB_DISABLE_TELEMETRY = '1'; $env:HYPERFRAMES_SKIP_SKILLS = '1'; $env:NARR = $Narr; $env:PROJ = $Proj
$py = "$H\.venv\Scripts\python.exe"; $hf = "$H\node\node_modules\hyperframes\bin\hyperframes.mjs"; $p = "$Lang-$Seed"
if (-not $SkipVoice) {
  if ($Lang -eq 'uk') { & "$H\.venv-omni\Scripts\python.exe" "$eng\tts_uk.py" $Narr $p $Voice $Seed } else { & $py "$eng\tts.py" $Seed $p $Lang $Voice }
  if ($LASTEXITCODE) { throw 'tts failed' } }
ffmpeg -hide_banner -loglevel error -y -i "$p.wav" -af "atempo=$Tempo,highpass=f=70,adelay=400:all=1,loudnorm=I=-14:TP=-1.5:LRA=9,aresample=48000" -ac 1 "$p-fast.wav"
if ($LASTEXITCODE) { throw 'ffmpeg failed' }
& $py "$eng\asr.py" "$p-fast" $Lang; node "$eng\build.mjs" "$p-fast.words.json" $Lang; if ($LASTEXITCODE) { throw 'build failed' }
& $py "$eng\pad.py" "$p-fast.wav" "$p-fast.words.json" segments.json "$p-pad.wav"; if ($LASTEXITCODE) { throw 'pad failed' }
& $py "$eng\asr.py" "$p-pad" $Lang; Copy-Item "$p-pad.wav" "$Proj\voice.wav" -Force
node "$eng\build.mjs" "$p-pad.words.json" $Lang; if ($LASTEXITCODE) { throw 'build failed' }
Copy-Item "$Proj\data.js" "$Proj\data.$Lang.js" -Force; Copy-Item "$p-pad.wav" "$Proj\voice.$Lang.wav" -Force
if ($PrepOnly) { return }
Set-Location $Proj
node $hf check; if ($LASTEXITCODE) { throw 'check failed' }
node $hf render --gpu -w 6 -o "$Work\render-$Lang.mp4"; if ($LASTEXITCODE) { throw 'render failed' }
Set-Location $Work
node "$eng\sfx.mjs" "$Work\render-$Lang.mp4" $Out; if ($LASTEXITCODE) { throw 'sfx mix failed' }
& $py "$eng\dropcheck.py" $Out "$Work\$p-pad.wav"; if ($LASTEXITCODE) { throw 'the finished video lost parts of the voice' }
# the .srt goes to its own folder: a same-name file next to the MP4 makes players draw it over the burned-in captions
$srtDir = Join-Path (Split-Path $Out) "$Name-srt"; New-Item -ItemType Directory -Force $srtDir | Out-Null
Copy-Item "$Work\subtitles.$Lang.srt" (Join-Path $srtDir "$Lang.srt") -Force
"done: $Out"
