import "server-only";

/** One login code on its way to the identifier it was asked for, in its normalised form. */
export type LoginCodeMessage = { channel: "phone" | "email"; to: string; code: string };

export type LoginCodeSender = { name: string; send(message: LoginCodeMessage): Promise<void> };

/**
 * Writes the code to stdout, one line per message. For local work and
 * staging only: the line holds a working code.
 */
const logSender: LoginCodeSender = {
  name: "log",
  async send({ to, code }) {
    console.log(`[login-code] to=${to} code=${code}`);
  },
};

/**
 * Where the log sender may run (D13): no Railway environment name, or
 * `staging`. `NODE_ENV` can't say: `next start` sets it to `production`
 * everywhere.
 */
const LOG_SENDER_ALLOWED = ["", "staging"];

let started: LoginCodeSender | undefined;

/**
 * This process's sender, started on first use and kept (D14). Where the log
 * sender is not allowed it throws, on every call: a failed start is not
 * remembered.
 */
export function loginCodeSender(): LoginCodeSender {
  if (started) return started;
  const environment = (process.env.RAILWAY_ENVIRONMENT_NAME ?? "");
  if (!LOG_SENDER_ALLOWED.includes(environment)) {
    throw new Error(
      `login code sender "log" refused: RAILWAY_ENVIRONMENT_NAME is "${environment}" (allowed: empty or "staging")`,
    );
  }
  started = logSender;
  return started;
}
