# Mada — clinic platform

Arabic-first physiotherapy SaaS. A thin intelligence layer beside the therapist:
voice-documented sessions, suggested clinical impressions, generated reports and
patient handouts, adherence tracking. Not a full clinic EMR.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Commands

```
npm run dev      # dev server on 3210
npm run build    # production build
npm start        # production server
npm run lint     # eslint
```

Verification harnesses live in `verify/` and run against a running server:
`node verify/e2e.mjs`, `verify/stt.mjs`, `verify/therapist.mjs`, `verify/soak.mjs`.
They need the server up first.

## Non-obvious architecture

- **`lib/server/db.ts`** — all persistence. SQLite via `better-sqlite3`, WAL mode.
  Server-only. Data lives under `MADA_DATA_DIR` (default `./data`), gitignored.
- **`lib/server/transcribe/`** — the transcription boundary. Its only contract is
  *file path in, Arabic text out*. Nothing outside this directory knows which
  provider is active. Keep it that way; it is meant to be liftable into its own
  service without touching anything else.
- **`lib/server/claude.ts`** — all model calls. No API key ever reaches the browser.
- **`lib/voice/recorder.ts`** — MediaRecorder capture, chunked upload during the
  session. Must survive a network drop mid-recording.
- **`lib/config.ts`** — the single hardcoded therapist and clinic. Temporary; it
  goes away when real auth lands.
- **`app/h/[token]/`** — the patient handout page. Reached by an unguessable token,
  no login.

## Rules

**Arabic RTL everywhere.** All user-facing text is Arabic. English appears only in
exercise names and technical identifiers. Never introduce English UI copy.

**The model proposes, the therapist decides.** Clinical output is always presented
as a suggestion the therapist approves — never applied automatically, never phrased
as a decision. Model impressions are stored on the session (`suggestedDx`) for
audit, separately from what the therapist approved. Preserve this framing in both
code and copy.

**Clinical content is placeholder.** Exercise descriptions and illustrations in
`lib/data/exercises.ts` are marked as placeholders awaiting the clinical lead.
Don't write new clinical claims, indications or contraindications.

## Don't touch without being asked

- `.env` — never read it, never print it, never commit it
- `data/` — real recordings and session data live here
- Billing, inventory and appointments screens — deliberately left as-is
- The approved visual design, Arabic typography and RTL layout
- `verify/` scripts — they are the record of what was proven to work
- `.claude/` — hook-protected (`.claude/hooks/guard.mjs`); only a human can change it

## Gotchas

- **Clear your timers.** A `setInterval` that outlives its component throws
  null-reference errors on every tick. This has happened once already.
- **Never kill processes by broad pattern.** A `pkill` for a dev server took down
  an unrelated process on this machine. Target a PID.
- **`vendor/`** holds a local whisper.cpp build — macOS/Metal only, gitignored,
  will not run on a Linux host. Hosted providers are configured by env var.
- **Never rebuild a file's contents from tool output.** Tool results truncate.
  Edit in place.

## Working agreement

- One task, one branch, one PR.
- Plan before implementing on anything touching data, auth or money.
- If a task needs restructuring beyond its stated scope, stop and report rather
  than expanding it.
- Show evidence — command output, test results — not claims that something works.

## Notes

Lessons from previous sessions are in `notes/lessons.md`. One lesson per entry with
a one-line summary at the top. Record corrections and confirmed approaches alike.
Don't record what the repo or git history already shows. Update an existing note
rather than adding a duplicate. Delete notes that turn out to be wrong.

## Specs

Every task starts with a spec. When asked to write one, follow
`docs/writing-specs.md` — structure, rules, and the questions you will be asked
about it. Propose the spec and stop; a separate session implements it.
