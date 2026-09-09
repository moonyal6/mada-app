# مدى — نظام إدارة العيادة (demo)

Full-stack conversion of `reference/mada-clinic-system.html` into a working
Next.js 16 app: one shared workspace (every therapist sees every patient; each
session records who ran it), one seeded clinic, everything the prototype
presents actually works — voice documentation with real Arabic
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
| `MADA_STT` | no | Default transcription provider: `openai`, `groq`, `local`, or `auto` (default — every configured one in that order, with failover). A therapist's choice in the recorder's picker overrides it per device. |
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
endpoint). The consent text shown to the therapist names every provider the
audio may reach under the current choice.

**Choosing and switching the provider.** Under the recorder there is a
picker, *مزوّد التفريغ*, listing every provider the server knows with its
availability (a missing key or binary shows as *غير متاح* with the reason;
the browser only ever sees names and availability, never keys). The choice is
stored in the `mada_stt` cookie — per device, for a year — and the server
reads it on every segment upload, so a switch made while a recording is
running applies from the next 15-second segment. Precedence is: the device's
choice → `MADA_STT` → `auto`. The two modes behave differently on failure:

- **`تلقائي` (auto)** tries the configured providers in order (OpenAI → Groq
  → local). When one fails for a reason another might not share — out of
  credit, invalid key, rate limit, unreachable, server error — the same
  segment is sent to the next one, and the recorder shows *تحوّل تلقائياً
  إلى …* naming the provider that actually produced the text. Only an
  unreadable audio file stops the chain.
- **A named provider** is pinned: it is used alone and never silently
  replaced, so a therapist who picked the local server for privacy never has
  audio sent elsewhere. When it fails, the segment fails with the message
  below and the picker is the way out (switch, then *إعادة المحاولة* — a
  retry always uses the device's *current* choice).

**What the error messages mean.** A failed segment shows a red line under the
recorder (the same text is stored on the segment); none of them carry a
status code. Every one ends with *تواصل مع المطوّر* because the fix is on the
server, not in the clinic:

| Message starts with | Cause | What to do |
|---|---|---|
| `انتهى رصيد <provider> (الحصة المدفوعة مستنفدة)` | The provider answered "insufficient quota" — the account is out of credit. | Top up or switch provider in the picker and retry. |
| `مفتاح <provider> غير صالح أو مرفوض` | 401/403 — the API key is wrong, revoked, or lacks permission. | Fix the key in `.env`, restart; or switch provider. |
| `<provider> يرفض الطلبات مؤقتاً لتجاوز حدّ الاستخدام` | 429 rate limit (not quota). Retried once automatically. | Wait, retry; if it persists, raise the limit or switch. |
| `تعذّر الوصول إلى <provider>` | DNS/TLS/connection failure or timeout; for the local server, it did not start. | Check the server's internet (or the whisper binary/model); the local provider needs no internet. |
| `عطل مؤقت لدى <provider>` | 5xx from the provider. Retried once automatically. | Wait, retry, or switch. |
| `<provider> لم يستطع قراءة هذا المقطع الصوتي` | The audio itself was rejected (corrupt or unsupported). Not sent elsewhere. | Re-record that part or type it. |
| `رفض <provider> طلب التفريغ (…)` | A 4xx that is neither audio nor auth — typically a wrong `MADA_STT_MODEL`. | Fix the configuration. |
| `<provider> غير متاح: …` | The pinned provider has no key / binary. | Pick another one; the picker marks it unavailable. |
| `لا يوجد مزوّد تفريغ صوتي مهيّأ على الخادم` | Nothing configured at all. Shown before recording; the mic is disabled. | Set a key or install whisper.cpp. |

**Silence and hallucination guard.** Whisper-family models fed a segment with
no speech do not return nothing — they invent fluent text, usually in the
wrong language and often one phrase repeated. Three things stop that:
segments with no detectable speech (ffmpeg decode → per-frame level against
the segment's own noise floor, < 0.5s above it) are skipped without being
sent, shown as *تم تجاوز N مقطع صامت*; every request runs at temperature 0
with an Arabic physiotherapy prompt (plus the transcript tail) so the first
words land in Arabic; and output that is still degenerate — heavy
repetition, or a script other than Arabic/Latin, or more Latin than Arabic —
is dropped and counted as *أُهمل N مقطع غير مفهوم* instead of entering the
dialogue. Stock subtitle-corpus phrases ("اشتركوا في القناة", "ترجمة نانسي
قنقر") are stripped. English exercise names inside Arabic pass.

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
  transcribes segments as they land, retries once when the failure was
  transient (rate limit, outage), then marks `failed` with an Arabic reason —
  which the UI surfaces as a retry button plus the message. Each segment
  records which provider produced its text and whether it was skipped as
  silence, dropped as degenerate, or answered by a fallback provider. Texts
  are appended to the dialogue strictly in segment order. Pending segments
  are re-queued after a server restart.
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
node verify/therapist.mjs         # therapist attribution: sidebar pick → cookie → stamped session →
                                  # report / handout / patient page; legacy sessions fall back
node verify/stt.mjs               # transcription resilience (starts its own production servers on 3210):
                                  # long silences → no hallucination; bad OpenAI key → Groq failover named in
                                  # the UI; out-of-credit → Arabic message on screen, switch + retry recovers;
                                  # picker persists and applies mid-recording; nothing configured → clear state.
                                  # ONLY=3,4 runs a subset. Needs `next build` and these fixtures:
say -v Majed -r 165 -o .verify-out/stt-a.aiff "الأخصائي: السلام عليكم، وش اللي جابك اليوم؟ المريض: عندي ألم في أسفل الظهر من شهر تقريباً، يزيد لما أجلس طويل ويخف لما أمشي."
say -v Majed -r 165 -o .verify-out/stt-b.aiff "الأخصائي: طيب، بنسوي فحص لمدى الحركة، وبنبدأ تمارين تقوية عضلات الظهر ثلاث مرات في الأسبوع."
for x in a b; do ffmpeg -y -i .verify-out/stt-$x.aiff -ar 48000 -ac 1 -acodec pcm_s16le .verify-out/stt-$x.wav; done
ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=mono -t 26 .verify-out/sil26.wav
ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=mono -t 22 .verify-out/sil22.wav
ffmpeg -y -i .verify-out/stt-a.wav -i .verify-out/sil26.wav -i .verify-out/stt-b.wav -i .verify-out/sil22.wav \
  -filter_complex "[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[a]" -map "[a]" .verify-out/stt-silences.wav
ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=mono -t 15 -c:a libopus -b:a 32k .verify-out/seg-silence.ogg
ffmpeg -y -f lavfi -i "anoisesrc=r=48000:c=pink:a=0.003" -t 15 -c:a libopus -b:a 32k .verify-out/seg-noise.ogg
ffmpeg -y -i .verify-out/stt-b.wav -t 4 .verify-out/b4.wav
ffmpeg -y -i .verify-out/b4.wav -i .verify-out/sil22.wav -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]" -map "[a]" -t 15 -c:a libopus -b:a 32k .verify-out/seg-short.ogg
ffmpeg -y -i .verify-out/stt-a.wav -c:a libopus -b:a 32k .verify-out/seg-speech.ogg
```

**Therapist attribution.** The sidebar's identity block is a picker: choose
from the device's short list or type a name. The choice lives in the
`mada_therapist` cookie (a year, per device) and is stamped onto
`sessions.therapistName` when a session is created; it is never patched
afterwards. Reports, the seal line, the printable handout and the patient page
read the session's name; rows from before the column existed are empty and
display the configured fallback in `lib/config.ts`. Added columns are applied
by `migrate()` in `lib/server/db.ts` (guarded `ALTER TABLE`, safe on every
start) — never delete `data/` to pick up a schema change.

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
| Transcription provider down / no key / out of credit | Visible "not configured" state before recording; in `auto` a failing provider is skipped for the next configured one and the UI names which one answered; pinned, the segment fails with a plain Arabic reason (out of credit, bad key, rate limit, unreachable) and a retry button, and the picker under the recorder switches provider on the spot. The local whisper provider works with no internet at all. Typing is always available. |
| Silence makes the model invent text | Segments with no detectable speech are never sent; temperature 0 + Arabic domain prompt; repeated or non-Arabic output is dropped and counted on screen rather than entering the dialogue. Verified with 26s and 22s silences inside a recording. |
| Microphone permission denied / no mic / Safari quirks | Clear Arabic error with a retry; `audio/mp4` fallback for Safari's MediaRecorder. Use Chrome for the demo. |
| Claude slow or refuses | Low-effort setting keeps drafting to a few seconds; server-side refusal fallback; a failed call shows a retry message and the manual mode still exists. |
| Browser refresh or laptop restart mid-session | Draft autosaves; the patient file offers "resume the ongoing session". |
| Patient's phone can't reach the server | The link is built from the therapist's origin — demo over the same LAN with a TLS proxy, or a tunnel. Test the QR from the actual phone before the session. |
| Dialect accuracy | Whisper/gpt-4o handle Gulf dialect reasonably but not perfectly; the transcript is editable and the assessment is a suggestion. Set expectations: it drafts, the therapist owns the text. |
| Dev tools indicator / dev mode | Demo with `npm run build && npm start` — no dev overlay, faster pages. |
| Stale data from rehearsals | Delete `data/` before the demo for a clean seed. |
