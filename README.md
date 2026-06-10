# Agentic Video Editor

Drop in raw footage, optionally paste a YouTube link as a style reference, and a Claude-powered agent probes the clips, picks moments, renders animated title cards, and produces an edited highlight video — all locally.

## What it can do

- **Auto-edit footage** — probes every clip, detects scene changes, samples interesting segments, trims to a target shot length, and concats them.
- **Style matching** — analyzes the reference's resolution, pacing, and scene-change density to choose a target aspect ratio, shot length, and transition feel.
- **YouTube reference** — paste a Shorts/watch URL; `yt-dlp` downloads it to use as the style reference. No file upload needed.
- **Animated title cards** — Remotion compositions rendered with React: spring-in titles, animated gradients, accent bars. Three themes (`minimal`, `bold`, `cinematic`).
- **Static text overlays** — burn captions, lower-thirds, or location labels onto specific clips via SVG → PNG + ffmpeg `overlay`.
- **Transitions** — xfade between clips (fade, dissolve, wipe, slide, circle reveal, etc.) with matching audio cross-fades.
- **Live agent log** — the upload page streams every tool call, decision, and progress event via SSE while the agent works.

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────────┐
│  app/page.tsx   │───▶│ POST /api/jobs   │───▶│  workspaces/<id>/        │
│  upload form    │    │  save files +    │    │   raw/                   │
└─────────────────┘    │  validate YT URL │    │   reference/             │
                       └────────┬─────────┘    │   clips/                 │
                                │              │   output/                │
                                ▼              └─────────────────────────┘
                       ┌──────────────────┐              ▲
                       │ runEditorAgent() │              │
                       │  (lib/agent.ts)  │              │
                       └────────┬─────────┘              │
                                │ Claude Agent SDK       │
                                ▼ (OAuth subscription)   │
                       ┌──────────────────┐              │
                       │  Claude reasons  │              │
                       │  + calls tools:  │              │
                       │   list_footage   │              │
                       │   probe_clip     │──┐           │
                       │   detect_scenes  │  │ ffmpeg    │
                       │   trim_clip      │──┤ ffprobe   │
                       │   add_text_overlay──┤ resvg     │
                       │   render_title_card─┤ Remotion  │
                       │   assemble_edit  │──┘ headless  │
                       │   note           │    Chromium  │
                       └────────┬─────────┘              │
                                │                        │
                                ▼                        │
                       output/final.mp4 ────────────────┘
```

```
app/job/[id]/page.tsx  ◀─── SSE  /api/jobs/[id]/stream  ◀─── job event bus
                       ◀─── HLS  /api/jobs/[id]/output  (range-aware mp4)
```

## Stack

- **Next.js 16** (App Router, Turbopack, React 19) with async route params and `RouteContext` typing
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — spawns the local Claude Code CLI, picks up your subscription auth via macOS Keychain. No `ANTHROPIC_API_KEY` needed.
- **Remotion** (`remotion`, `@remotion/bundler`, `@remotion/renderer`) — programmatic React-to-video bundling and headless rendering for animated title cards
- **@resvg/resvg-js** — pure-Rust SVG → PNG for static text overlays
- **ffmpeg + ffprobe** — probing, scene detection, trim, scale/pad, xfade, acrossfade, overlay
- **yt-dlp** — YouTube reference downloads, capped at 720p

## Setup

Run the setup script. It detects everything you already have and prompts before installing what's missing.

```bash
./setup.sh
```

If you'd rather do it by hand, install: Node.js ≥ 20.9, Homebrew, ffmpeg, yt-dlp, the Claude Code CLI (`npm install -g @anthropic-ai/claude-code`), then `npm install` and `npx next typegen`.

You also need to be logged in to Claude Code at least once. Run `claude` interactively to complete the OAuth flow if you haven't already; the Agent SDK reuses that auth.

## Running

```bash
npm run dev
# open http://localhost:3000
```

1. Pick one or more footage clips (any video format ffmpeg can read).
2. Optionally either upload a reference clip OR paste a YouTube Shorts/watch URL.
3. Click **Start editing**.
4. You're redirected to the job page; agent activity streams live. When `output/final.mp4` is ready it appears in a player with a download link.

## How the agent decides

The system prompt in `lib/agent.ts` instructs Claude to follow a fixed workflow:

1. List footage and the reference.
2. Probe everything (`ffprobe`).
3. Choose target resolution — match the reference if present, otherwise most common footage resolution, default 1920×1080.
4. Run scene detection on reference and footage. Reference's average shot gap → target shot length (clamped to 1.5–6s). Reference's scene-change density → "energetic" vs "contemplative" feel.
5. Trim 6–20 interesting segments from the footage.
6. Optionally render an animated intro/outro via Remotion. Theme matches the reference's mood (bold for energetic, cinematic for atmospheric, minimal otherwise).
7. Optionally burn static text overlays onto specific clips.
8. Pick a transition based on energy — hard cuts or short fades for energetic, dissolve 0.5–0.8s for contemplative.
9. Call `assemble_edit` once. Done.

You can edit `SYSTEM_PROMPT` in `lib/agent.ts` to change the aesthetic the agent reaches for.

## Project layout

```
app/                       Next.js App Router
├── page.tsx               upload form (client)
├── job/[id]/              live progress + result player
└── api/jobs/              POST, GET, /stream (SSE), /output (range mp4)

lib/
├── agent.ts               Claude Agent SDK setup + MCP tool definitions + system prompt
├── ffmpeg.ts              probe, detectScenes, trim, concat (with xfade), addTextOverlays
├── remotion.ts            bundle + selectComposition + renderMedia (cached)
├── text.ts                SVG → PNG text rendering
├── youtube.ts             URL validation + yt-dlp download
├── jobs.ts                in-memory job registry + workspace paths + SSE event bus
└── types.ts

remotion/
├── index.ts               registerRoot
├── Root.tsx               composition registry
└── TitleCard.tsx          animated title card component

workspaces/<job-id>/       per-job scratch (gitignored)
├── raw/                   uploaded footage
├── reference/             uploaded or downloaded reference, plus .url file
├── clips/                 trimmed + overlay-burned + Remotion-rendered intermediates
└── output/final.mp4       the result
```

## Notes

- **Costs**: agent runs use your Claude subscription (OAuth, not API key). A typical edit is ~15–20 turns and reports ~$0.10–$0.25 in token-cost telemetry; you don't pay that on top of your subscription.
- **First Remotion render** downloads ~150 MB of headless Chromium. Subsequent renders reuse it; the bundle is cached per dev-server process.
- **Job state is in-memory** — if you restart `next dev` mid-job, the SSE stream drops. Files on disk persist.
- **No transcription yet** — the agent only sees visual/metadata signals (scene cuts, resolution, duration). Adding `whisper.cpp` would unlock speech-driven cuts.
- **Next.js 16 specifics** — async `params`/`searchParams`, Turbopack default, `serverExternalPackages` for native modules (`@resvg/resvg-js`, `@remotion/*`, Agent SDK). See `AGENTS.md`.

## License

Personal project. Use videos you own or have rights to draw inspiration from when supplying a YouTube reference.
