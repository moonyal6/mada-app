/**
 * Transcription failures, typed. Two independent flags decide what happens
 * next: `failover` — another provider might succeed with the same audio
 * (quota, key, outage) versus not (the audio itself is unreadable);
 * `transient` — the same provider may succeed a moment later.
 *
 * `message` is the Arabic text the therapist sees: what happened, in plain
 * words, and who to call. Status codes and provider payloads stay in `detail`
 * for the server log.
 */

export type SttErrorCode =
  | "quota"
  | "auth"
  | "rate_limit"
  | "unreachable"
  | "server"
  | "bad_audio"
  | "rejected"
  | "unavailable"
  | "no_provider";

export class SttError extends Error {
  code: SttErrorCode;
  providerLabel: string;
  failover: boolean;
  transient: boolean;
  detail: string;

  constructor(code: SttErrorCode, providerLabel: string, detail = "") {
    super(describe(code, providerLabel, detail));
    this.name = "SttError";
    this.code = code;
    this.providerLabel = providerLabel;
    this.detail = detail;
    this.failover = code !== "bad_audio" && code !== "no_provider";
    this.transient = code === "rate_limit" || code === "unreachable" || code === "server";
  }
}

const CONTACT = "تواصل مع المطوّر.";

function describe(code: SttErrorCode, label: string, detail: string): string {
  switch (code) {
    case "quota":
      return `انتهى رصيد ${label} (الحصة المدفوعة مستنفدة) فلا يمكن التفريغ عبره حتى يُعاد شحنه. ${CONTACT}`;
    case "auth":
      return `مفتاح ${label} غير صالح أو مرفوض، فلا يمكن التفريغ عبره. ${CONTACT}`;
    case "rate_limit":
      return `${label} يرفض الطلبات مؤقتاً لتجاوز حدّ الاستخدام. ستُعاد المحاولة تلقائياً، وإن استمرّ ذلك ${CONTACT}`;
    case "unreachable":
      return `تعذّر الوصول إلى ${label}. تحقّق من اتصال الخادم بالإنترنت، وإن استمرّ ذلك ${CONTACT}`;
    case "server":
      return `عطل مؤقت لدى ${label}. ستُعاد المحاولة تلقائياً، وإن استمرّ ذلك ${CONTACT}`;
    case "bad_audio":
      return `${label} لم يستطع قراءة هذا المقطع الصوتي. أعد تسجيل ما قيل أو اكتبه يدوياً.`;
    case "rejected":
      return `رفض ${label} طلب التفريغ${detail ? ` (${detail})` : ""}. ${CONTACT}`;
    case "unavailable":
      return `${label} غير متاح${detail ? `: ${detail}` : ""}. اختر مزوّداً آخر أو ${CONTACT}`;
    case "no_provider":
      return `لا يوجد مزوّد تفريغ صوتي مهيّأ على الخادم. ${CONTACT}`;
  }
}

/** Map an OpenAI-compatible HTTP failure onto a code. */
export function fromHttp(label: string, status: number, body: string): SttError {
  const b = body.toLowerCase();
  const detail = `${status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
  if (status === 401 || status === 403) return new SttError("auth", label, detail);
  if (status === 402) return new SttError("quota", label, detail);
  if (status === 429) {
    if (/insufficient_quota|quota|billing|credit|balance|exceeded your current/.test(b)) {
      return new SttError("quota", label, detail);
    }
    return new SttError("rate_limit", label, detail);
  }
  if (status >= 500) return new SttError("server", label, detail);
  if (status === 413 || status === 415) return new SttError("bad_audio", label, detail);
  if (status === 400 || status === 422) {
    if (/audio|file|decod|format|corrupt|duration|too short|empty/.test(b)) {
      return new SttError("bad_audio", label, detail);
    }
  }
  return new SttError("rejected", label, detail);
}

/** fetch() threw: DNS, refused, TLS, timeout — all "can't reach it". */
export function fromFetchFailure(label: string, err: unknown): SttError {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  return new SttError(
    "unreachable",
    label,
    [name, cause, msg].filter(Boolean).join(" ").slice(0, 200),
  );
}

export function asSttError(err: unknown, label: string): SttError {
  if (err instanceof SttError) return err;
  return new SttError("server", label, err instanceof Error ? err.message : String(err));
}

/** One message for the whole chain when every provider failed. */
export function combine(failures: SttError[]): SttError {
  if (failures.length === 1) return failures[0];
  const e = new SttError(failures[0].code, failures[0].providerLabel, failures[0].detail);
  e.message =
    "تعذّر التفريغ عبر جميع المزوّدين المتاحين. " +
    failures.map((f) => f.message).join(" ");
  e.failover = false;
  e.transient = failures.every((f) => f.transient);
  return e;
}
