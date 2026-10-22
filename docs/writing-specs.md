# Writing a spec

Every task starts with a spec. This file says how to produce one.

When asked to write a spec for an issue, **read the issue and the relevant code
first, then propose the spec. Do not write implementation code.** The spec is the
deliverable for that session; a separate session implements it.

## Structure

```
GOAL
One or two sentences: what, and why it matters. State the current situation if
it explains the need.

SCOPE
What to build. Name the files and interfaces involved where they are known.

OUT OF SCOPE
What not to touch, named explicitly — files, directories, screens, concerns.
This section is not optional. A spec without it invites scope drift.

VERIFICATION
How we know it worked, written as checks that can actually be run. Each one
should be something that would fail if the work were wrong. Include at least
one negative case: what should fail, and the proof that it does.

If this needs restructuring beyond the scope above, stop and report instead of
expanding it.
```

That closing line belongs in every spec.

## Rules

**Be specific.** "Handle errors properly" is not a spec. "A failed upload shows
the Arabic retry message and the segment stays queued" is.

**Verification must be runnable.** "Works correctly" is not verification. A
command, a test, an observable state change is.

**Prove the negative.** A check that has only ever passed proves nothing. Specify
what should fail and how we confirm it does — a deliberately broken input, a
dropped policy, a revoked permission.

**Size it to one reviewable diff.** If the spec would produce a change too large
to read carefully in one sitting, split it into two specs and say so.

**Don't invent requirements.** If something was not stated and cannot be inferred
from the code, ask rather than assume. Flag the assumptions you did make.

## Review questions

Expect to be asked these. Answer them specifically; vague answers mean the task
is not understood yet.

1. What did you assume that was not stated?
2. What is the smallest version of this?
3. What are you deliberately not touching?
4. How will we know it worked — what exactly would fail if it did not?
5. What could go wrong that would only show up in production?

## Review tiers

Issues carry a label that sets the treatment:

- `review:deep` — auth, tenancy, payments, migrations, data deletion. The test
  list is reviewed and approved before implementation. Tests are written in a
  separate session from the implementation, and confirmed to fail first.
- `review:light` — features touching patient data. Agent writes the tests.
- `review:none` — UI, copy, styling. Proceed without a detailed spec review.
