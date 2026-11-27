import "server-only";
import { createHash, randomInt } from "node:crypto";
import { LOGIN_CODE_DIGITS, normalizeCode, normalizeIdentifier } from "@/lib/signInInput";
import { loginCodeCheck, loginCodeIssue } from "./db";
import { loginCodeSender, type LoginCodeSender } from "./loginCodeSender";

/*
 * Login codes (#45): what sign-in (#46) calls. The plain code exists only
 * here, in memory, and in the sender's message: the database gets its hash.
 * No log line or error message written here holds a code, a hash or an
 * identifier.
 */

/** D1: LOGIN_CODE_DIGITS digits from the CSPRNG, leading zeros kept. */
function newCode(): string {
  return String(randomInt(0, 10 ** LOGIN_CODE_DIGITS)).padStart(LOGIN_CODE_DIGITS, "0");
}

/** D4: lower-case hex SHA-256 over the normalised identifier and the code. */
function codeHash(identifier: string, code: string): string {
  return createHash("sha256").update(`mada-login-code/v1\n${identifier}\n${code}`, "utf8").digest("hex");
}

/**
 * Asks for a code. `accepted` whether or not an account has the identifier
 * (D12). The sender is checked first: where it may not run, no code is
 * generated and the database is not touched.
 */
export async function requestLoginCode(input: {
  identifier: string;
  ip: string;
}): Promise<{ status: "accepted" | "invalid_identifier" | "too_many_requests" | "sender_unavailable" }> {
  const identifier = normalizeIdentifier(input.identifier);
  if (!identifier) return { status: "invalid_identifier" };

  let sender: LoginCodeSender;
  try {
    sender = loginCodeSender();
  } catch (e) {
    console.error("[auth] " + (e instanceof Error ? e.message : String(e)));
    return { status: "sender_unavailable" };
  }

  const code = newCode();
  const issued = await loginCodeIssue(identifier.value, input.ip, codeHash(identifier.value, code));
  if (issued === "limited") return { status: "too_many_requests" };
  if (issued === "issued") {
    try {
      await sender.send({ channel: identifier.kind, to: identifier.value, code });
      console.log(`[auth] code sent to ${identifier.value}`);
    } catch {
      // The error may hold the message it failed to send: it is not logged.
      console.error(`[auth] login code send failed (${sender.name})`);
    }
  }
  return { status: "accepted" };
}

/** Checks a code. `ok` uses it up; every other outcome is the same for known and unknown identifiers. */
export async function checkLoginCode(input: {
  identifier: string;
  code: string;
  ip: string;
}): Promise<
  | { status: "ok"; staffId: string; clinicId: string; role: "owner" | "therapist" }
  | { status: "invalid_identifier" | "invalid_code_format" | "invalid_code" | "too_many_attempts" }
> {
  const identifier = normalizeIdentifier(input.identifier);
  if (!identifier) return { status: "invalid_identifier" };
  const code = normalizeCode(input.code);
  if (!code) return { status: "invalid_code_format" };

  const result = await loginCodeCheck(identifier.value, input.ip, codeHash(identifier.value, code));
  if (result.outcome === "ok") {
    return { status: "ok", staffId: result.staffId, clinicId: result.clinicId, role: result.role };
  }
  return { status: result.outcome === "blocked" ? "too_many_attempts" : "invalid_code" };
}
