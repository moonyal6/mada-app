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
