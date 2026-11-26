// Founder command (#44): creates a clinic with its owner account, or gives an
// existing clinic (such as c1) an owner. It is the only way to create a clinic
// for now: there is no self-signup. A person runs it with the database
// owner's login; the app role can't write these tables.
//
//   node scripts/founder.mjs --clinic-name <name> --owner-name <name> [--phone <phone>] [--email <email>]
//   node scripts/founder.mjs --clinic-id <id>     --owner-name <name> [--phone <phone>] [--email <email>]
//
// The connection is the DATABASE_OWNER_URL variable of the process
// environment and nothing else. No env file is loaded, there is no fallback
// to DATABASE_URL, and the PG* variables (PGHOST, PGUSER, …) are removed from
// this process before pg can read them. The README ("Creating a clinic and
// its owner") shows how to set it for one command without exporting it.
//
// Exit 0: committed. stdout is one line of JSON; stderr has the target line.
// Exit 1: the database could not be reached, refused, or failed. The last
//         stderr line says why and ends "Nothing was written." The exception
//         is a failed COMMIT: then the outcome is not known, and it says so.
// Exit 2: invalid arguments, or a DATABASE_OWNER_URL that can't be used. No
//         connection was opened.
//
// Rules that hold in every line below:
//  - Every value, typed or generated, reaches the database as a bound
//    parameter ($1, $2, …). No SQL text is ever built from a value.
//  - DATABASE_OWNER_URL is never parsed here. `new URL()` on a malformed
//    value throws an error that carries the whole value, password included.
//    pg parses it, and its parser redacts that.
//  - Until the connection is open, nothing taken from DATABASE_OWNER_URL is
//    printed: not the value, not a host or a database read from it, not a
//    caught error and not its message. After a mistyped URL any of those can
//    hold a piece of the password. Only an error's `code` is printed, with
//    wording written here.
//  - No message repeats an argument, apart from the clinic id that wasn't
//    found. That is why the argument parser's own messages aren't printed.
//  - The command creates no table, runs no migration, grants nothing and
//    sets no clinic context: the owner role is not subject to the policies.

import { randomUUID } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";
import pg from "pg";

const { argv, env, stderr, stdout } = process;

const USAGE = [
  "usage: node scripts/founder.mjs --clinic-name <name> --owner-name <name> [--phone <phone>] [--email <email>]",
  "       node scripts/founder.mjs --clinic-id <id>     --owner-name <name> [--phone <phone>] [--email <email>]",
  "       Each option once, and at least one of --phone and --email.",
].join("\n");

/** `multiple`, so an option given twice is seen and refused, instead of the last one winning. */
const OPTIONS = /** @type {const} */ ({
  "clinic-name": { type: "string", multiple: true },
  "clinic-id": { type: "string", multiple: true },
  "owner-name": { type: "string", multiple: true },
  phone: { type: "string", multiple: true },
  email: { type: "string", multiple: true },
});

/** E.164, exactly as typed: no trimming, no digit conversion, no country-code guessing. */
const PHONE = /^\+[1-9][0-9]{7,14}$/;
/**
 * Plain ASCII, checked before lower-casing: U+212A (Kelvin sign) lower-cases
 * to "k". No `i` flag for the same reason.
 */
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const EMAIL_MAX = 254;
const CONTROL = /\p{Cc}/u;

/** The only role this command writes. */
const ROLE = "owner";

const TARGET = "founder: target: ";
const NOTHING = "Nothing was written.";

/**
 * What to write, validated. Exactly one of `clinicName` and `clinicId` is set.
 * @typedef {{
 *   clinicName: string | null,
 *   clinicId: string | null,
 *   ownerName: string,
 *   phone: string | null,
 *   email: string | null,
 * }} Input
 */

/**
 * What a committed run wrote: the success JSON.
 * @typedef {{
 *   clinic: { id: string, name: string, created: boolean },
 *   owner: { id: string, name: string, phone: string | null, email: string | null },
 *   role: string,
 * }} Written
 */

/**
 * How a run that got past its checks ended. `last` is the last stderr line,
 * without its `founder: ` prefix.
 * @typedef {{ exit: 0, written: Written } | { exit: 1, last: string }} Outcome
 */

/** An id in the shape of `uid()` in lib/server/db.ts: the prefix and 12 hex digits. @param {string} prefix */
const uid = (prefix) => prefix + randomUUID().replaceAll("-", "").slice(0, 12);

/**
 * An error's `code` when it looks like one: a SQLSTATE (23505) or one of
 * Node's (ECONNREFUSED). Never its message.
 * @param {unknown} err
 * @returns {string | null}
 */
function codeOf(err) {
  const code = /** @type {{ code?: unknown } | null | undefined} */ (err)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

/** Exit 2: the reason, then the usage. Nothing was attempted. @param {string} reason */
function refuse(reason) {
  stderr.write(`founder: ${reason}\n${USAGE}\n`);
  return 2;
}

/** What `parseArgs` refused, by its error code. Its message quotes the argument, so it isn't printed. */
const UNREADABLE = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: "unknown option. The options are listed below.",
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: "unexpected argument. Every value belongs to one of the options below.",
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE:
    "an option has no value. A value that starts with a dash is written --option=value.",
};

/** No positional arguments and no other options: `parseArgs` throws on either. @param {string[]} args */
const parse = (args) => parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }).values;

/**
 * A name as it is stored: trimmed. Null when that leaves nothing, or when it
 * holds a control character.
 * @param {string} typed
 */
function storedName(typed) {
  const name = typed.trim();
  return name === "" || CONTROL.test(name) ? null : name;
}

const NAME_RULE = "must not be empty, and must not contain a control character such as a line break.";

/**
 * Reads and validates the arguments. Nothing here touches the database.
 * @param {string[]} args
 * @returns {{ input: Input } | { problem: string }}
 */
function readArguments(args) {
  /** @type {ReturnType<typeof parse>} */
  let values;
  try {
    values = parse(args);
  } catch (e) {
    const code = /** @type {keyof typeof UNREADABLE | null} */ (codeOf(e));
    return { problem: (code && UNREADABLE[code]) || "the arguments could not be read." };
  }
  for (const [name, given] of Object.entries(values)) {
    if (given.length > 1) return { problem: `--${name} was given more than once.` };
  }
  const clinicNameTyped = values["clinic-name"]?.[0];
  const clinicIdTyped = values["clinic-id"]?.[0];
  const ownerNameTyped = values["owner-name"]?.[0];
  const phone = values.phone?.[0] ?? null;
  const emailTyped = values.email?.[0] ?? null;

  if ((clinicNameTyped === undefined) === (clinicIdTyped === undefined)) {
    return { problem: "give exactly one of --clinic-name (create a clinic) and --clinic-id (use an existing one)." };
  }
  if (ownerNameTyped === undefined) return { problem: "--owner-name is required." };
  if (phone === null && emailTyped === null) return { problem: "give --phone, --email or both." };

  const ownerName = storedName(ownerNameTyped);
  if (ownerName === null) return { problem: `--owner-name ${NAME_RULE}` };
  const clinicName = clinicNameTyped === undefined ? null : storedName(clinicNameTyped);
  if (clinicNameTyped !== undefined && clinicName === null) return { problem: `--clinic-name ${NAME_RULE}` };

  // Used as typed.
  if (clinicIdTyped === "") return { problem: "--clinic-id must not be empty." };

  if (phone !== null && !PHONE.test(phone)) {
    return {
      problem:
        "--phone must be typed in full international form: a plus sign, then the country code and number, " +
        "8 to 15 ASCII digits and nothing else. For example +966501234567.",
    };
  }

  if (emailTyped !== null && (emailTyped.length > EMAIL_MAX || !EMAIL.test(emailTyped))) {
    return {
      problem:
        `--email must be a plain ASCII address such as name@clinic.example, at most ${EMAIL_MAX} characters, ` +
        "with nothing before or after it.",
    };
  }

  return {
    input: {
      clinicName,
      clinicId: clinicIdTyped ?? null,
      ownerName,
      phone,
      // Stored lower-cased: sign-in looks an account up by the stored form.
      email: emailTyped === null ? null : emailTyped.toLowerCase(),
    },
  };
}

/**
 * A client for DATABASE_OWNER_URL, not yet connected, or why the value can't
 * be used. No connection is attempted here. pg parses the value when the
 * client is constructed.
 * @returns {{ client: pg.Client } | { problem: string }}
 */
function ownerClient() {
  const url = env.DATABASE_OWNER_URL;
  if (!url) {
    return { problem: "DATABASE_OWNER_URL is not set. Set it to the database owner's URL, for this command only." };
  }
  // Without this pg takes a value with no scheme, such as a pasted password,
  // for a database name on a host called "base", and looks that host up.
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
    return { problem: "DATABASE_OWNER_URL must start with postgres:// or postgresql://. Its value is not shown." };
  }
  // pg fills in whatever the URL leaves out (host, port, user, password,
  // database, TLS mode) from the PG* variables, when the client is
  // constructed and again when it looks for a password. Removed from this
  // process first, so an incomplete URL can't be completed into some other
  // database. What is still left out falls back to pg's built-in defaults
  // (localhost, 5432, the operating-system user); the target line shows it.
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("PG")) delete env[name];
  }
  stderr.write(`founder: connecting to ${new URL(url).hostname}\n`);
  try {
    return { client: new pg.Client({ connectionString: url }) };
  } catch {
    // The error is not looked at: there is nothing in it that may be printed.
    return {
      problem:
        "DATABASE_OWNER_URL is not a URL that pg can read. Its value is not shown. " +
        "Check the port, and that reserved characters in the password (such as / @ : ? #) are percent-encoded.",
    };
  }
}

/**
 * The words for an error that happened before COMMIT was sent. Only the
 * error's code and constraint name are read.
 * @param {unknown} err
 */
function explain(err) {
  const code = codeOf(err);
  const constraint = /** @type {{ constraint?: unknown } | null | undefined} */ (err)?.constraint;
  // When both collide Postgres reports the phone.
  if (code === "23505" && constraint === "staff_phone_key") return "that phone is already stored for an account.";
  if (code === "23505" && constraint === "staff_email_key") return "that email is already stored for an account.";
  if (code === "42P01") {
    return "a table is missing (42P01): this database is not migrated. The server migrates it on its first request.";
  }
  if (code === "42501") {
    return "permission denied (42501): DATABASE_OWNER_URL must connect as the role that owns the tables, not as the app role.";
  }
  if (code !== null) return `database error ${code}, before COMMIT was sent.`;
  return "the connection was lost, or the run failed, before COMMIT was sent (no error code).";
}

/**
 * Connects, prints the target line, and does the writes in one transaction.
 * Never throws: every way it can end is an Outcome.
 * @param {pg.Client} client
 * @param {Input} input
 * @returns {Promise<Outcome>}
 */
async function write(client, input) {
  // Open the connection and ask the server where this is. A run that fails
  // here has no target line, and its last line carries only the error's code.
  /** @type {{ database: string, role: string }} */
  let who;
  try {
    await client.connect();
    [who] = (await client.query("SELECT current_database() AS database, current_user AS role")).rows;
  } catch (e) {
    return { exit: 1, last: `could not connect to the database (${codeOf(e) ?? "no error code"}). ${NOTHING}` };
  }
  // Where this run writes, before it writes: host and port as pg parsed and
  // connected to them, database and role as the server reports them.
  stderr.write(`${TARGET}host ${client.host}, port ${client.port}, database ${who.database}, role ${who.role}\n`);

  let commitSent = false;
  try {
    const at = new Date().toISOString();
    await client.query("BEGIN");

    /** @type {Written["clinic"]} */
    let clinic;
    if (input.clinicId === null) {
      clinic = { id: uid("c"), name: /** @type {string} */ (input.clinicName), created: true };
      await client.query(`INSERT INTO clinics(id, name, "createdAt") VALUES ($1, $2, $3)`, [clinic.id, clinic.name, at]);
    } else {
      const found = await client.query("SELECT id, name FROM clinics WHERE id = $1", [input.clinicId]);
      if (found.rows.length === 0) {
        await client.query("ROLLBACK").catch(() => {});
        return { exit: 1, last: `no clinic with id ${JSON.stringify(input.clinicId)}. ${NOTHING}` };
      }
      clinic = { id: found.rows[0].id, name: found.rows[0].name, created: false };
    }

    const owner = { id: uid("u"), name: input.ownerName, phone: input.phone, email: input.email };
    await client.query(`INSERT INTO staff(id, name, phone, email, "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
      owner.id,
      owner.name,
      owner.phone,
      owner.email,
      at,
    ]);
    await client.query(`INSERT INTO memberships(staff_id, clinic_id, role, "createdAt") VALUES ($1, $2, $3, $4)`, [
      owner.id,
      clinic.id,
      ROLE,
      at,
    ]);

    commitSent = true;
    await client.query("COMMIT");
    return { exit: 0, written: { clinic, owner, role: ROLE } };
  } catch (e) {
    if (commitSent) {
      // The server may have committed before the failure reached us, so
      // "Nothing was written." would be a guess.
      return {
        exit: 1,
        last:
          `COMMIT failed (${codeOf(e) ?? "no error code"}). It is not known whether the rows were written. ` +
          "Look for the account before running this again (README, Creating a clinic and its owner).",
      };
    }
    await client.query("ROLLBACK").catch(() => {});
    return { exit: 1, last: `${explain(e)} ${NOTHING}` };
  }
}

/** @returns {Promise<number>} the exit code */
async function main() {
  // Everything is checked before any connection is opened.
  const read = readArguments(argv.slice(2));
  if ("problem" in read) return refuse(read.problem);
  const owner = ownerClient();
  if ("problem" in owner) return refuse(owner.problem);
  const { client } = owner;

  // pg emits "error" on the client when its connection drops. With no
  // listener Node would throw that error and print it whole. Every failure
  // is reported by the call that was waiting on it instead.
  client.on("error", () => {});

  const outcome = await write(client, read.input);
  // The outcome is printed before the connection is closed, so a slow close
  // can't hold it back.
  if (outcome.exit === 0) stdout.write(`${JSON.stringify(outcome.written)}\n`);
  else stderr.write(`founder: ${outcome.last}\n`);
  await client.end().catch(() => {});
  return outcome.exit;
}

// Set, not process.exit(): the output is flushed before the process ends.
process.exitCode = await main();
