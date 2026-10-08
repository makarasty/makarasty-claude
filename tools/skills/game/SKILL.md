---
description: Tunes this computer for one game - reads the hardware, disks, drivers and the game's install, proposes changes with evidence (runtime version, launch flags, disk placement, in-game and driver settings), has a red team try to disprove each one, and ends with a short plain report of what survived. Applies nothing without a yes per item. Use on "оптимизируй под игру", "оптимизируй майнкрафт", "game Minecraft", "ускорь игру", "лагает игра", "мало фпс", "долго грузит карту", "настрой комп под <игру>", "tune my PC for <game>", "boost fps".
argument-hint: "<game name> [fps | loading | stutter | RAM]"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, Agent, ToolSearch, WebSearch, WebFetch, SendMessage, Write
---

Tune this machine for the game `$ARGUMENTS` names. The output is a short list of changes that each survived
an attempt to disprove them, and the operator decides which to apply.

**Secrets stay closed.** Launcher folders hold account tokens: never open `accounts.json`,
`launcher_accounts*.json`, or `*.dat` files in a launcher's root. Server addresses and chat lines from game
logs stay out of the report.

## 1. Inventory, read only, in two calls

**Call 1**, one batched script:

- CPU, cores, RAM total and free; current CPU load per process from one 2 s sample (`Get-Counter
  '\Process(*)\% Processor Time'`; `Get-Process`'s CPU is cumulative history) and memory from WorkingSet64.
- GPU: name; VRAM from `nvidia-smi` or the registry's `HardwareInformation.qwMemorySize`
  (`Win32_VideoController.AdapterRAM` caps at 4 GB); driver version (NVIDIA's is the last five digits of
  `DriverVersion`, `32.0.16.1692` is 616.92). Whether an integrated GPU is enabled beside it.
- OS build and power plan. A modified Windows (AtlasOS, ReviOS, Tiny11) already applies the usual tweaks: read
  a value before proposing to change it.
- Disks: `Get-PhysicalDisk` for media and bus, `Get-Partition | ? DriveLetter` to tie a letter to its disk
  number, `Get-Volume` for free space. Elsewhere `lsblk -d -o NAME,ROTA,SIZE` and `df -h`.
- Every place the game can be installed: Steam libraries (`libraryfolders.vdf`), Epic manifests, Xbox and
  Store packages (`Get-AppxPackage`), the uninstall registry keys, and the game's known launcher folders (for
  Minecraft: `%APPDATA%\.minecraft`, `%APPDATA%\PrismLauncher`, `%APPDATA%\ModrinthApp`,
  `~\curseforge\minecraft\Instances`, `%APPDATA%\ATLauncher`, `%APPDATA%\MultiMC`, `%APPDATA%\.lunarclient`).
- `~/.claude/makarasty/upkeep.json` when it exists (`$env:USERPROFILE\.claude\makarasty\upkeep.json` in
  PowerShell): what an earlier `game` or `update` run installed.

**Call 2**: read the config of every launcher and install found: the runtime it points at and its version
(`cmd /c "java -version 2>&1"`: PowerShell 5.1 loses stderr otherwise), memory and GC flags, per-instance
overrides, mods and shaders, and from the last game log (`.log.gz` read in memory, not unpacked to disk) the
renderer, the GPU that actually drew and the JVM arguments actually used. Whether the operator plays
single-player or on servers: on a server, view and simulation distance are the server's.

Done when every item above has a value or says "not found".

## 2. Proposals

Each proposal: what to change, the exact command or setting, the effect and how big, the source (a vendor or
official page, a benchmark with numbers, or a measurement on this machine), the risk, the undo, and who does
it: `agent` (an install, a launcher setting) or `operator` (Windows settings, the GPU control panel, closing
their own programs).

- **Runtime**: the version the game supports, newest patch. A suitable runtime already on disk is pointed at,
  not installed a second time.
- **Placement**: what loads often on the fastest disk with room, the system disk kept free. A launcher that
  keeps data and runtimes in `%APPDATA%` (Prism, the Mojang launcher) is in its standard place.
- **Drivers**: only when the vendor's own site confirms a newer version for this exact GPU.
- **In-game settings**: only for a symptom the operator named. With none named and the game not running,
  propose no setting; say in one line what to measure (for Minecraft, F3: FPS and memory used) and stop there.

A claim with no source and no measurement is not a proposal. Forum lore is not a source.

## 3. Red team

One `Agent` (`subagent_type: general-purpose`, `model: opus`, in the foreground), the proposals inline in its
prompt, told: read only, no installs, no settings, do not launch the game or end processes; disprove each
proposal - wrong for this game version, no measurable effect, a myth, a hidden risk, a conflict with another
proposal; every `stands` or `falls` names a source URL or a file on this machine, and a reason from memory is
marked `(memory)` and decides nothing by itself. Where it is wrong, answer once with `SendMessage` to its
agent id and the source. Keep what stands.

## 4. Report, then apply on a yes

Plain text in the chat, in the operator's language, no page:

```
<game> on <one line: CPU, RAM, GPU and driver, disks>
Do:
1. [agent|operator] <change> - <effect> (<source>)  undo: <how>
Dropped: <change> - <why it fell>, one line each
```

Ask once which numbers to apply. Then, for `agent` items only:

- Launcher and game closed before any config edit (a running launcher writes its own copy back); the file
  backed up first, and the undo restores that backup.
- Installs one at a time through the platform's package manager (`winget install --id <id> -e`, `brew`,
  `apt`) into its default path, after naming the package, source and size; no `--accept-package-agreements`
  or `--accept-source-agreements` without the operator's yes. Drivers are `operator` items: give the steps.
- Each change recorded in `~/.claude/makarasty/upkeep.json` (create the folder if missing; read, merge,
  write) as `{"items":[{"item","manager","id","old","new","path","date","by":"game","undo"}]}`.

`operator` items get exact steps; the operator's programs are never closed or ended by you. Done when the
operator has the report and every applied item is recorded with its undo.
