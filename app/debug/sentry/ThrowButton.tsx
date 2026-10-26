"use client";

/**
 * Throws from an event handler: no error boundary sees it, so this proves the
 * browser SDK's global handler reports uncaught errors.
 */
export function ThrowButton() {
  return (
    <button
      type="button"
      onClick={() => {
        throw new Error("Sentry verification: deliberate client throw");
      }}
    >
      Throw client error
    </button>
  );
}
