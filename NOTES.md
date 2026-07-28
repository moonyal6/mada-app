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
