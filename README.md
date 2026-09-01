# مدى — نظام إدارة العيادة (demo)

Full-stack conversion of `reference/mada-clinic-system.html` into a working
Next.js 16 app: one hardcoded therapist, one seeded clinic, everything the
prototype presents actually works — voice documentation with real Arabic
transcription, a suggested (never imposed) clinical impression, Claude-drafted
reports, a printable handout with QR codes, a patient page on the phone that
logs adherence and pain, and a follow-up screen driven by those logs.

## Run it

```bash
npm install
cp .env.example .env         # then fill in the keys (see below)
npm run dev -- -p 3210       # or: npm run build && npm start -- -p 3210
```

Open <http://localhost:3210>. The database (`data/mada.db`) and uploaded audio
(`data/recordings/`) are created on first start and seeded with the
prototype's demo patients; delete `data/` to reset. The app is a plain Node
server — not serverless — because sessions upload audio for 40+ minutes and
transcription calls are slow.

The patient page must be reachable from the patient's phone, so run the server
on the clinic's LAN (or a VPS/container) and open the app by that host name;
the handout's portal link/QR is built from whatever origin the therapist's
browser used. Microphone capture requires HTTPS or `localhost` — put a TLS
proxy (Caddy, nginx) in front when demoing over the LAN.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Report drafting, assessment/impression suggestion, exercise search (`claude-opus-5`, low effort). Server-only. |
| `MADA_STT` | no | Transcription provider: `openai`, `groq`, `local`, or `auto` (default — first available in that order). |
| `OPENAI_API_KEY` | one of | OpenAI `gpt-4o-transcribe` (recommended hosted option for Arabic quality). |
| `GROQ_API_KEY` | one of | Groq-hosted `whisper-large-v3` (cheap/fast alternative, OpenAI-compatible). |
| `MADA_STT_MODEL` | no | Override the hosted model name. |
| `WHISPER_SERVER`, `WHISPER_MODEL`, `WHISPER_PORT`, `FFMPEG_PATH` | no | Paths for the local whisper.cpp provider (defaults under `vendor/whisper-cpp/`, `ffmpeg` on PATH). |
| `MADA_CLAUDE_MODEL` | no | Override the Claude model id. |
| `MADA_DATA_DIR` | no | Where `mada.db` and recordings live (default `./data`). |

No key ever reaches the browser: transcription and model calls all run in
route handlers. If report generation, the suggestion button or exercise search
answer with a 502, look at the server log: `[claude] 401 … API key is invalid`
means the Anthropic key needs replacing; `[claude] 429` means rate limiting.

### Transcription provider — evaluation and recommendation

The provider sits behind one module, `lib/server/transcribe/`, whose only
contract is *file path in, Arabic text out*. Nothing else in the codebase knows
which provider is active, so it can later be lifted into its own service
untouched.

| Option | Arabic quality | Latency | Data path | Verdict |
|---|---|---|---|---|
| **OpenAI `gpt-4o-transcribe`** | best of the hosted options for Gulf dialect | ~2–4s per 15s segment | audio leaves the clinic to OpenAI | **Recommended for the pilot** when a key is available |
| Groq `whisper-large-v3` | good MSA, weaker on dialect | ~1s per segment | audio leaves the clinic to Groq | cheapest; fine for the demo |
| **Local whisper.cpp** (`large-v3-turbo`, Metal on Apple Silicon) | good; near-identical to Groq's model | ~1.5–3s per segment once warm | **audio never leaves the clinic machine** | what this demo was verified with; the PDPL-friendly path and the fallback for flaky clinic wifi |

Both hosted options are the same code path (OpenAI-compatible multipart
endpoint). With no hosted key present, `auto` selects the local provider if the
binary and model exist. The consent text shown to the therapist names whichever
provider is active.

**Setting up the local provider** (what the verified demo runs):

```bash
# native arm64 build with Metal; cmake from cmake.org if brew's is x86
git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp
cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/whisper.cpp/build -j8
mkdir -p vendor/whisper-cpp/models
cp /tmp/whisper.cpp/build/bin/whisper-server vendor/whisper-cpp/
curl -L -o vendor/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
brew install ffmpeg   # converts browser audio to 16 kHz wav
```

`whisper-server` is spawned by the app on first use and kept warm (a cold CLI
run pays ~15s of model load per segment; the warm server answers in ~1.5s).

## How the core loop is built

- **Voice capture** (`lib/voice/recorder.ts`): MediaRecorder is rotated every
  15s so each segment is a standalone file. Segments upload as produced; on a
  network drop they queue in memory and retry with backoff (visible to the
  therapist as a red "reconnecting" badge), so nothing recorded before or
  during the drop is lost. Consent is captured before the first recording of a
  session and stored with a timestamp (`sessions.consentAt`); the server
  refuses to open a recording without it.
- **Transcription** (`lib/server/transcribe/queue.ts`): an in-process queue
  transcribes segments as they land, retries once, then marks `failed` — which
  the UI surfaces as a retry button. Texts are appended to the dialogue strictly
  in segment order. Pending segments are re-queued after a server restart.
- **Suggestion, not decision**: the assessment summary and impressions come
  back as a draft the therapist inserts or ignores; impressions appear as
  suggestion chips beside the diagnosis field and are stored on the session
  for audit (`suggestedDx`), never auto-applied.
- **Report**: the drafting package is shown verbatim, sent to Claude, rendered
  as Markdown, editable, then sealed. Manual copy/paste remains as a fallback
  mode but is never required.
- **Persistence**: SQLite via better-sqlite3 (WAL). Session drafts autosave
  (debounced, deduped) and can be resumed from the patient file; refresh and
  server restart lose nothing.
- **Patient page** (`/h/[token]`): unguessable token, no login, mobile-first.
  Daily check-off per exercise and a 0–10 pain score, written to
  `adherence`/`pain_logs`. The follow-up screen computes adherence as checked
  exercise-days ÷ (exercises × days) over the last 7 days of the current plan —
  `—` until a plan exists, never a made-up number.

## Intentionally stubbed / placeholder for the demo

- **Exercise descriptions and illustrations are placeholders** — flagged in
  `lib/data/exercises.ts`, in the generator `scripts/gen-exercise-svgs.mjs`,
  and on the therapist's exercises card. The clinical lead replaces them.
- **Videos** are live public demonstrations from hospital/physio channels (NUH
  Physiotherapy, HSS, TSAOG, POGO Physio, …), verified via YouTube oEmbed, for
  back, neck, neck-strain and knee (18 exercises). Shoulder, ankle and post-op
  entries render an honest "no video yet" tile until the clinic supplies its
  own unlisted links.
- **Reference library**: only the low-back entry is approved (as in the
  prototype); other cases show "awaiting preparation".
- **Billing, inventory, appointments** are migrated as-is onto the database —
  same behaviour and appearance, nothing more.
- **Not built** (per scope): authentication, roles, multi-clinic, VAT/e-invoice,
  payments, reminders, settings, dashboards beyond the prototype's, own video
  hosting, audio deletion workflow (audio stays under `data/recordings/`).
- **Demo identity** is hardcoded in `lib/config.ts`.

## Verification

Scripts in `verify/` drive a real Chromium against a running instance:

```bash
# Arabic dialogue for the fake microphone (macOS voice)
say -v Majed -r 165 -o .verify-out/dialogue.aiff "الطبيب: السلام عليكم، وش اللي جابك اليوم؟ …"
ffmpeg -i .verify-out/dialogue.aiff -ar 48000 -ac 1 -acodec pcm_s16le .verify-out/dialogue.wav

node verify/smoke.mjs   # every screen loads, zero console errors
node verify/e2e.mjs     # the full loop: consent → record → 35s network drop → transcript →
                        # suggestion → approval → report → seal → handout → patient phone →
                        # adherence/pain → follow-up → refresh → server restart
MINUTES=40 node verify/soak.mjs   # long recording with a 30s drop every 2 minutes
```

What was verified on this machine is listed under "Verification results" below.

## Verification results (this machine, 2026-08-31)

Run against the production build (`next build && next start -p 3210`), local
whisper.cpp provider, real Chromium with a fake microphone playing a 69s
synthesised Arabic clinic dialogue (`verify/e2e.mjs`, `.verify-out/e2e-prod.log`):

| # | Requirement | Result |
|---|---|---|
| 1 | Real session recorded through the microphone → Arabic transcript | ✅ 788-char transcript containing the spoken content, segments appended in order |
| 2 | Mid-session network drop loses nothing | ✅ 35s offline while recording: red "reconnecting" badge shown, queued segments uploaded on reconnect, no failed segments. Long-run soak: see below |
| 3 | Approve impression + exercises, generate report, no copy-paste | ⚠️ **Blocked by environment**: the `ANTHROPIC_API_KEY` in `.env` is rejected by the API (`401 authentication_error: API key is invalid`). The route handlers, prompts and UI are wired and the failure surfaces cleanly (502 → visible retry message). The run used `ALLOW_NO_CLAUDE=1`, which types the assessment and pastes a report instead; the approval/seal path itself passed. Re-run `node verify/e2e.mjs` with a valid key to close this item |
| 4 | Handout reaches the patient by link, opens on a phone, QR → real videos | ✅ portal link + QR on the handout; iPhone-13 viewport, no horizontal overflow; exercise links are live YouTube videos (verified via oEmbed) |
| 5 | Patient logs completion + pain; follow-up reflects it from stored data | ✅ 2/2 exercises checked and pain 4/10 → follow-up shows ١٠٠٪ and "آخر ألم مسجّل: ٤/١٠" |
| 6 | Survives browser refresh and server restart | ✅ therapist follow-up and patient page re-checked after reload and after killing/restarting the server |
| 7 | Zero uncaught exceptions in the console across the flow | ✅ 0 console/page errors on both the therapist and patient pages (19 resource-load failures logged by Chromium *during the deliberate outage* are counted separately) |

Every screen also loads with zero console errors (`verify/smoke.mjs`), `npm run lint`
and `tsc --noEmit` are clean, and `next build` succeeds.

**Long recording** (`MINUTES=5 node verify/soak.mjs`, `.verify-out/soak.log`): 5 minutes of
continuous recording with a 30s network drop every 90s (two drops). All 20/20
segments (seq 0–19, no gaps, ~56 KB each at 32 kbps) reached the server and were
transcribed; 2,467 characters of dialogue on screen matched the autosaved row;
the queue drained within 6s of stopping; zero page errors. At this bitrate a
40-minute session is ~160 segments / ~9 MB, and nothing in the pipeline scales
with session length — the same run at `MINUTES=40` is the remaining thing to do
on the demo machine before the day.

## Ways this can fail in front of an audience — and what was done about it

| Risk | Mitigation |
|---|---|
| Clinic wifi drops mid-session | Segments queue locally and retry; badge shows it; nothing lost. Verified with a 35s drop while recording. |
| Transcription provider down / no key | Visible "not configured" state before recording, failed segments show a retry button, and the local whisper provider works with no internet at all. Typing is always available. |
| Microphone permission denied / no mic / Safari quirks | Clear Arabic error with a retry; `audio/mp4` fallback for Safari's MediaRecorder. Use Chrome for the demo. |
| Claude slow or refuses | Low-effort setting keeps drafting to a few seconds; server-side refusal fallback; a failed call shows a retry message and the manual mode still exists. |
| Browser refresh or laptop restart mid-session | Draft autosaves; the patient file offers "resume the ongoing session". |
| Patient's phone can't reach the server | The link is built from the therapist's origin — demo over the same LAN with a TLS proxy, or a tunnel. Test the QR from the actual phone before the session. |
| Dialect accuracy | Whisper/gpt-4o handle Gulf dialect reasonably but not perfectly; the transcript is editable and the assessment is a suggestion. Set expectations: it drafts, the therapist owns the text. |
| Dev tools indicator / dev mode | Demo with `npm run build && npm start` — no dev overlay, faster pages. |
| Stale data from rehearsals | Delete `data/` before the demo for a clean seed. |
