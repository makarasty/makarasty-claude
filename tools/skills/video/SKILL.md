---
description: "Makes a short vertical explainer video for TikTok, Shorts or Reels: script, voice, animation, captions, MP4 on the Desktop. make a video / сделай видео, сделай ролик, видос про, озвучь и смонтируй. Not screenshot reports (proof)."
argument-hint: [what the video is about, languages]
---

The person judges the result by eye and ear, rates it out of 10 and expects 8-9. You cannot listen or watch in
real time, so every sound and layout defect you can measure is measured by a script before the MP4 reaches them,
and the report says plainly what was not checked by ear.

Engine: `${CLAUDE_SKILL_DIR}/engine/make.ps1` runs one language end to end. Heavy parts (two Python venvs, model
cache, HyperFrames) live in `$env:MK_VIDEO_HOME`, default `%LOCALAPPDATA%\makarasty\video` (call it HOME). If HOME
is missing, set it up from `${CLAUDE_SKILL_DIR}/SETUP.md` first. Each video gets its own work folder
`HOME\work\<name>`; outputs go to the Desktop as `<name>-<lang>.mp4` plus `<name>-srt\<lang>.srt`.

## Flow

1. **Brief.** Topic, who watches, languages, where it is posted. Default 60-75 s, 1080x1920. Use the names, people
   and assets the person really has (ask for avatars or a logo); a made-up name or face is the first thing they notice.
2. **Script.** `narration.<lang>.json` in the work folder: 7-10 segments `{"id","text","beats"}`, one or two short
   sentences each, the hook in the first two seconds. `beats` maps a name to the stem of a word spoken in that
   segment (`{"num": "восемьдесят"}`); the composition animates on `DATA.segments[i].beats.num`, so one composition
   serves every language. Translate keeping the beat names, with stems from the translated text. Numbers as words:
   the voice and the aligner both handle them better. Pass the text through `/makarasty-tools:unslop` before voicing.
3. **Look.** Read `HOME\looks.md` (one line per earlier video). Build 3-4 teaser mockups (8-10 s, two scenes,
   the first two segments) that differ from each other and from every line there: typography, palette, motion idea,
   background, caption shape. Render each with the same steps as the full video, put them on one comparison page
   on the Desktop (`/makarasty-tools:report`, MP4 links) and let the person pick. A look that served one video is
   not reused for the next one unless they ask.
4. **Voice.** Russian and English: Qwen3-TTS VoiceDesign, the whole script in one call so the voice stays the same;
   voices are descriptions in `engine/voices.json` (`calm_ru`, `calm_en` are the person's earlier pick: calm, soft,
   male, no foreign accent). Ukrainian: OmniVoice (`engine/tts_uk.py`): scene 1 from a description, cloned for the
   rest. Never clone a voice from a take in another language: the Ukrainian take picked up Russian words. When the
   person has not picked a voice for this kind of video, offer 2-3 samples on the comparison page.
5. **Compose** `hf\index.html` in the chosen look. `${CLAUDE_SKILL_DIR}/example/` is the reference for the contract
   with the engine, not for the look: a paused GSAP timeline at `window.__timelines["main"]`, `class="clip"` elements
   with `data-start`/`data-duration` (the engine stamps `data-duration`), `voice.wav` as the audio, `window.DATA`
   from `data.js` (`lang, dur, endCard, segments[{start,end,beats,words}], chunks`), on-screen words per language in
   `strings.js`. Read the HyperFrames docs in HOME\node\node_modules\hyperframes before the first composition.
6. **Render** each language: `powershell -File "${CLAUDE_SKILL_DIR}/engine/make.ps1" -Lang ru -Work <work folder>`
   (`-Voice`, `-Seed`, `-Tempo 1.05` for a slow voice, `-SkipVoice` to reuse `<lang>-<seed>.wav`, `-PrepOnly` to stop
   before the render). Run it in the background, one language at a time: the render uses the GPU and 6 workers.
7. **Check by eye.** `node HOME\node\node_modules\hyperframes\bin\hyperframes.mjs snapshot` at every beat, read the
   contact sheet, and fix what you see before the person does. Then deliver and append one line to `HOME\looks.md`:
   date, name, look in a few words, voice.

## Traps already paid for

Each of these reached the person once. The engine guards the sound ones; the picture ones are yours.

- **Cut-off audio.** Whisper word ends are often early, so a cut placed there chops the word's tail. `pad.py` edits
  only runs the audio itself shows silent and asserts it; `make.ps1` refuses an MP4 whose voice differs from the
  voice track (`dropcheck.py`). Keep both. A new sound effect is a separate ffmpeg input per hit, no limiter: one
  input fed into many filter chains, plus a limiter, punched dips into the voice.
- **Long pauses and a sigh at the end.** `pad.py` shrinks pauses and ends the voice 0.25 s after the last sound.
  Whisper invents words in the trailing silence ("Редактор субтитров"); words past the script's end are dropped.
- **Duplicated captions.** A `.srt` with the MP4's name beside it makes players draw it over the burned-in
  captions; the engine puts it in its own folder.
- **Crooked captions.** One line, at most 4 words / 17 letters (the engine groups them); mark the spoken word with a
  pill or colour, never by scaling it, which shifts the line.
- **Twitching avatar mouth.** Ease the mouth shape per word; never jump it per frame.
- **Stray decoration.** Every element on screen says something; a small accent bar over a title read as a glitch.
- **Missing Cyrillic.** The font embedder picks glyphs from the text it finds in the HTML; words injected from
  `strings.js` are not there. Keep a hidden block with every glyph each face uses (the example has one).
- **Safe zones.** Text and key art inside x 132-876, y 288-1248; nothing right of x 780 below y 840 (the platform
  buttons). `hyperframes check` reports overflows; zero warnings before render.
- **Licence.** OmniVoice weights are CC-BY-NC: say so before a Ukrainian video is used commercially.

## Report

The Desktop paths, the length of each MP4, the `dropcheck` line per language, and one line on what was not checked
by ear (intonation, stress in names, timbre).
