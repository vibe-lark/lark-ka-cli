const SECRET_KEY =
  /^(?:app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|user[_-]?access[_-]?token|tenant[_-]?access[_-]?token|session[_-]?token|device[_-]?code|authorization|password|secret|token|private[_-]?key)$/i;

export class CliError extends Error {
  constructor(type, message, { hint, code = 2, detail } = {}) {
    super(message);
    this.name = "CliError";
    this.type = type;
    this.code = code;
    this.exitCode = code;
    if (hint !== undefined) this.hint = hint;
    if (detail !== undefined) this.detail = detail;
  }
}

function redactText(value) {
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(
      /(--(?:app-secret|client-secret|access-token|refresh-token|session-token|password)\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token|device[_-]?code|password)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:token|secret|code|session_token|access_token|refresh_token|client_secret|app_secret)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    );
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      value: SECRET_KEY.test(key) ? "[REDACTED]" : redact(entry, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(value);
  return result;
}

export function toErrorEnvelope(error) {
  const expected = error instanceof CliError;
  const detail = {
    type: expected ? error.type : "internal",
    code: expected ? error.code : 1,
    message: error?.message ? String(error.message) : String(error),
  };
  if (error?.hint !== undefined) detail.hint = error.hint;
  if (error?.detail !== undefined) detail.detail = error.detail;
  return redact({ ok: false, error: detail });
}
