# Build notes — trial features

One lesson per entry. Corrections and confirmed approaches alike; skip anything
the code or commits already record.

## Persistence

- **Gate rendering on `ready`, don't lazy-init from localStorage.** The
  bundled Next 16 guide (`preventing-flash-before-hydration.md`) confirms a
  lazy `useState` reading localStorage causes a hydration error, and its
  inline-script fix only suits small text corrections — not swapping an entire
  session state. Rendering the TopBar shell until the store is read avoids
  both the mismatch and a blank first paint.
- **The paste-only field has a second enemy: the browser itself.** Firefox
  restores *uncontrolled* form fields on reload (its session restore, outside
  React). `autoComplete="off"` on the paste textarea opts out. App-side
  persistence never touches that field — it has no binding to session state.
- **Dedupe autosaves by JSON snapshot.** Without `lastSavedJsonRef`, every
  refresh/resume bumps `updatedAt` and reorders the list without any real
  change. Comparing the serialized state before writing keeps timestamps
  honest — they now mean "content changed".
- **`sealedAt` records the most recent seal.** Unseal→edit→reseal moves it
  forward; unseal without resealing leaves the old stamp. Fine for the trial
  metric (open→seal duration), worth remembering when reading exports.
- **Corrupt stores are stashed, not deleted** (`mada.store.unreadable`), so a
  parse bug can't destroy trial data. The visible warning + empty list is the
  degraded mode; import remains the recovery path.
- **Known limitation: two tabs = last writer wins.** The whole store is one
  key; no cross-tab sync. Single-clinician trial makes this acceptable.

## Continuity

- **"New visit" carries exactly what the spec lists — nothing more.** Patient
  data, diagnosis (`doctor.dx`) and the basket carry; dialogue, report and
  pain start empty *and so does the rest of the doctor's opinion* (session
  count, frequency, advice, plan notes). Diagnosis being singled out reads as
  deliberate: the plan is per-visit, the diagnosis usually isn't. Flag if the
  physio disagrees — easy to widen later.
- **Every path into the session view goes through the home screen** (or the
  initial mount), so the wizard subtree always mounts fresh on a session
  switch. That's what guarantees the uncontrolled paste box and per-stage
  local state can't leak between patients — no keying tricks needed.
- **Resuming without editing must not reorder the list.** Same snapshot-dedupe
  as persistence: open + look + leave keeps `updatedAt` untouched.
- **No delete on the list — deliberately.** The scope named list/resume/new
  visit only, and deletion is a data-lifecycle (product) call. Raised in the
  handover instead of built.

## Video library

- **The basket snapshots the library URL at selection time.** `selected[].url`
  is copied from `EX[].video` when the exercise is toggled in, because the
  doctor can override it per exercise. Consequence: when real video URLs land
  in `exercises.ts`, sessions saved before that keep their empty URL (and the
  "no video" tile) — re-toggling the exercise picks up the new URL. Fine for
  the trial; a migration would only matter with real data at stake.
- **Placeholder URLs were load-bearing lies.** The old code QR-encoded
  `https://mada.app/ex/...` fabrications everywhere (case toggle, added
  exercises, handout fallback). All three sources are gone — empty means
  empty, and the UI says so instead of encoding it.

## Web Speech API with Arabic (revisit before scaling this)

- **Interim results are display-only, never state.** Interim transcripts get
  rewritten by the engine as it re-decodes; committing them would corrupt the
  saved dialogue. The textarea shows `dialogue + "\n" + interim` as a view
  concern; only `isFinal` phrases dispatch. This also keeps autosave from
  churning on every interim rewrite.
- **Chromium ends "continuous" recognition constantly.** ~8s of silence fires
  `no-speech` then `onend`; the engine also recycles itself periodically. A
  clinic session has long silences, so benign ends auto-restart while the
  doctor hasn't pressed stop. Guard: 5 sub-second ends with no results = a
  real mic/engine problem → stop with the error label, don't loop.
- **On every `onend`, commit the leftover interim.** The engine drops
  whatever never finalized; without this, the last phrase before a
  silence-restart (or before stop) vanishes. If the engine did finalize it,
  the interim ref is already empty — no duplication.
- **Error taxonomy that matters:** `not-allowed`/`service-not-allowed` =
  denied (fatal, show settings hint); `audio-capture`/`network` = fatal error
  (Chromium's recognition is server-side — offline clinic wifi will surface
  as `network`); `no-speech`/`aborted` = routine, let `onend` decide.
- **ar-SA specifics to watch in the clinic trial:** recognition quality for
  Saudi dialect vs MSA is the open question we can't test from here — the
  engine is Google's server-side model on Chrome. No punctuation is produced;
  no speaker separation (the "الطبيب:/المريض:" convention has to be typed or
  edited in). Safari supports webkitSpeechRecognition but may deliver
  finals-only (the UI degrades gracefully — no live stream, phrases appear on
  finalize). Firefox has no support → the labelled unsupported state.
- **Typing while an interim phrase is on screen** adopts the shown text into
  the dialogue (it stops being provisional). If recognition then finalizes
  the same phrase it appends again — a rare, visible, editable duplicate.
  Accepted for the trial instead of a lock that would fight the "typing
  always available" rule.
- **Audio is never stored** — recognition streams from the mic; only text
  touches state, and only finalized text at that.
