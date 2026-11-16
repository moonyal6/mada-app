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
dictation.٩

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

## A schema change is a new migration file, never an edit to an applied one
On SQLite, adding `therapistName` to the `CREATE TABLE IF NOT EXISTS` string
did nothing to the existing database. The same trap exists on Postgres (#30):
the runner records `0001_init.sql` by name in `schema_migrations`, so editing
that file changes fresh databases only and silently skips every deployed one.
Add `migrations/000N_<what>.sql` instead.

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


## Scrubbing `event.request` is not enough — Next puts the raw path in a context
With `request` reduced to method + clean URL, the server event still carried
`?patient=…`: `onRequestError` records `contexts.nextjs.request_path` with the
query string. Only sending a real event to a local stand-in ingest and
grepping the envelope for planted values found it; the unit tests, written
from the SDK's documented fields, passed. Keep `verify/sentry.mjs` planting
values in every part of the request when the SDK is upgraded.

## Claude Code hot-loads hooks: the session that registers a guard is guarded at once
Issue #3 assumed hooks load once at session start. They don't: as soon as
the settings file registering the PreToolUse guard was written, the next
Bash call in that same session was denied. Why it mattered: the live checks
(plant a fake secret file, edit settings in a worktree) became impossible
from that session, and getting past the guard would have meant working around
it. Run anything that needs guarded paths before registering the hook, or
hand it to a human as a script.

## `next start` loads the env files, but an empty string in the process env wins
@next/env only fills a key whose process value is `undefined`, so spawning
`next start` with `SENTRY_DSN: ""` and `ANTHROPIC_API_KEY: ""` overrides the
env files without anyone reading them. Keys the spawner doesn't name still
come through. `NEXT_PUBLIC_*` is inlined at build time, so a runtime override
only covers server code. (Read in `node_modules/@next/env/dist/index.js` for
the baseline runner, #7.)

## A random ID as the sort tie-breaker makes the order random across runs
`listInvoices` sorts `date DESC, id DESC`, which reads as deterministic. But
every invoice is dated the day it's created, so within a run the order comes
from `uid()`'s random hex. Each fresh instance gave a different order and the
baseline replay failed 6 runs out of 6 on the two invoice lists, nothing else.
Fix that worked (#7b): check the sort rule on the raw response and compare the
items in a fixed order, so a reversed `ORDER BY` still fails. Look for this
before recording any list whose sort key can tie on a generated ID.

## tsc misses a dropped `await` on a write or behind `!`; only the call audit sees it
In 8a (#28), removing the `await` from `setAdherence(...)` (a void write) and
from `if (!(await setAppointmentStatus(...)))` left `tsc` and `eslint` clean:
a bare Promise statement is legal, and `!promise` is just `false`. Only the
symbol-resolving audit (in the #28 PR) flagged both. Why it matters: on
SQLite the write still lands a microtask later, so it looks fine; on Postgres
it races the response. A dropped `await` on a value that is then read
(`patient.name`) is caught by `tsc`. Re-run the audit after any change to
db call sites until a type-aware floating-promise lint rule exists.

## Commit before probing with mutations; `git checkout -- <file>` undoes your work too
Reverting a probe mutation with `git checkout -- <file>` restored the file
to HEAD, which also threw away the uncommitted refactor in those two files.
Caught because the editor reported the change; re-applied by hand. Commit
the real change first, then mutate and revert against that commit.

## Parallel sessions share one checkout — start a task in its own worktree
8b-1 ran alongside 8a. `git status` was clean at session start, but by the
time I ran `git switch -c` the 8a session had 14 uncommitted files in the
same directory; the switch moved its HEAD to my branch and my `npm run build`
replaced its `.next`. Caught within a minute, switched back, nothing lost.
Rule: when another session may be live, re-check `git status` right before
switching, and do the work in `git worktree add <scratch>/wt -b <branch> main`
with its own `npm ci`. Port 3211 is still shared, so check `lsof` before a
baseline run.

## A new leading `string` param type-checks old calls that passed one optional string
In 9b (#9), `listAppointments(date?)` became `listAppointments(clinicId, date?)`.
An unconverted `listAppointments(today)` would still compile, with the date
read as the clinic id: an empty list, no error. Same for `listInvoices` and
`listSessions` with their optional `patientId`. `tsc` only catches callers
whose arity changed. After adding a leading argument, grep every call site
of each function that had an optional parameter and check the first argument.

## Under RLS, a new auto-numbered column must be IDENTITY, not `serial`
`inventory.seq` is `GENERATED ALWAYS AS IDENTITY`, and `mada_app` inserts
into it with no grant on its sequence: Postgres doesn't check sequence
privileges for an identity column's default. A `serial` column's default is
a plain `nextval()`, which does, so the app role's insert would fail with
42501 until someone grants USAGE on the sequence. R4 (#10) would then go red,
because it expects the role's grants to be exactly 0003's list. Use IDENTITY
for new columns rather than adding a sequence grant.
