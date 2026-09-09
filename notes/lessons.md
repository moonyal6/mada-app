# Build lessons — clinic-system conversion

One lesson per entry, one-line summary first. Corrections and confirmed
approaches alike; nothing the code, commits, or README already record.

## Never `pkill -f "next dev"` on a shared machine
Killed the user's unrelated dev server on port 3000 while restarting mine.
Why it mattered: the other process was invisible to my task but visible to
the user. Kill by PID from `lsof -iTCP:<port>`, or start on a dedicated port
(`-p 3210`) from the outset and never touch other ports.

## `git add -A` before the ignore line lands = a 400MB blob in history
The whisper model was downloading in `vendor/` while the "server foundation"
commit ran; `/vendor` went into .gitignore only afterwards. Why it mattered:
the next commit timed out compressing the blob, and HEAD carried 414MB
toward a GitHub remote. Fix that worked: `git rm -r --cached vendor`, amend,
`git reflog expire --expire=now --all && git gc --prune=now` (838M → 400K).
Rule: write the ignore entry *before* the first artefact appears.

## Cold whisper-cli is 10× slower than a warm whisper-server
Per-invocation model load cost ~15s for a 10s clip; whisper-server with the
model resident answered the same clip in 1.5s. Why it mattered: 15s segments
would have queued behind real time on the local provider. The server is
spawned lazily (and pre-warmed from the consent dialog's /api/stt call).

## Rotate MediaRecorder per segment; don't use `timeslice`
`timeslice` chunks after the first aren't standalone (no container header),
so each would need the whole stream to decode. Stopping and restarting the
recorder every 15s makes every blob independently decodable, uploadable,
retryable and transcribable. The ~ms gap at rotation is inaudible in
dictation.

## Apply transcript segments in seq order; a failed one holds the cursor
Segments finish out of order (retries, queue). Appending on arrival would
scramble the dialogue. The cursor only advances past `done` segments; a
`failed` one blocks and surfaces as the visible retry button rather than
silently dropping a chunk of the session.

## `NODE_PATH` does not work for ESM scripts
Playwright scripts in the scratchpad couldn't resolve the repo's
node_modules. Keeping verification scripts inside the repo (`verify/`) fixes
resolution and makes them a deliverable.

## Turbopack picks the wrong root when a stray lockfile sits in $HOME
`/Users/moony/package-lock.json` made Next infer the home directory as the
workspace root. `turbopack.root = __dirname` in next.config.ts pins it.

## A ref read during render fails `react-hooks/refs` — latch with state instead
`shownRef.current || !!session.report` looked harmless (a "panel stays open
once shown" latch) but the lint rule is right: a ref mutation doesn't
re-render, so the latch can silently lag. `useState(!!report)` + an effect
that sets it true when the report appears is the same latch, observably.

## Playwright strict mode counts `aria-label` as the accessible name
`getByRole("button", { name: /بدء التسجيل/ })` matched both the modal's
confirm button *and* the mic button, whose `aria-label` is the same phrase.
Scope role queries to their container (`page.locator(".modal").getByRole…`)
in an app where the same Arabic verb labels several controls.

## The React-compiler lint set forbids `setState` inside effects — design around it
`react-hooks/set-state-in-effect` flagged three "obvious" patterns: latching a
flag when a prop appears, deriving `window.location.origin` on mount, and
closing a mobile menu on route change. Each had an effect-free shape: latch in
the handler that causes the change, lazy `useState(() => …)` for a
client-only value (the component never SSRs), and close the menu in the
link's `onClick`. Why it mattered: `npm run lint` is part of the build gate
and the effect versions also re-render one extra time.

## Run the browser verification against `next start`, not `next dev`
Against the dev server the final "server restart" check produced six console
errors and one aborted reload — all of them `/_next/webpack-hmr` socket
reconnects and the dev recompile racing the navigation. None exist in
production. The harness now buckets HMR noise separately and `START=prod`
restarts with `npm start`; the demo itself should run the production build for
the same reason (no dev overlay, no recompile stalls on first navigation).

## A per-device choice the server also needs belongs in a cookie, not localStorage
The therapist name is read on the server twice — by the clinic layout (so the
sidebar SSRs the right name with no hydration mismatch or flash) and by
`POST /api/sessions` (to stamp the row). localStorage would have forced a
`ready` gate in the shell and a name in every create-request body. One cookie
serves both readers; only the *list* of names, which no server code needs and
which is only read on click, stays in localStorage.

## `CREATE TABLE IF NOT EXISTS` silently ignores new columns
Adding `therapistName` to the schema string did nothing to the existing
`data/mada.db`. Additive migrations now live in a `MIGRATIONS` table checked
against `PRAGMA table_info` on every start (no version counter to keep in
sync; re-running is a no-op). Verified: all row counts identical before/after.

## Whisper on silence invents text — gate the audio, not just the output
A 15s segment with no speech came back as fluent, repeated, wrong-language
sentences, and one 2s tail segment as a plausible Arabic sentence nobody
said. Text filters (repetition ratio, script check) catch the first kind
but not the second. Why it mattered: the invented lines looked like real
dialogue in the transcript. Fix that worked: measure speech presence with
ffmpeg before sending (per-frame dBFS against the segment's own floor,
< 0.5s of voiced audio → skip), temperature 0, domain prompt, then the text
filters as the last line. Order matters: silence never reaches the model.

## A pinned provider must not fail over; only `auto` may
The consent text tells the patient where the audio goes. Failing over from
"local" to OpenAI on an error would break that promise silently. So an
explicit choice (cookie or `MADA_STT`) is used alone and fails loudly with
an Arabic reason plus the picker; `auto` is the mode that hops providers
and says which one answered.

## The cookie is the right channel for a per-device server-side choice
The provider choice has to be per device *and* readable by the server on
each segment upload, mid-recording. localStorage is neither; a per-recording
column would freeze the choice at start. Storing the raw cookie value on the
segment row at upload (and re-reading it on retry) makes "switch, then
retry" work without any provider knowledge outside the transcribe module.

