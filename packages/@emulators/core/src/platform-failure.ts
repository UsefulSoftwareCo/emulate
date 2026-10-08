// Cloudflare raises its own runtime failures (a Durable Object that moved to a
// different machine, a lost connection, an overloaded object) as exceptions
// flagged `.retryable` or `.overloaded`. Emulator code must not answer these as
// its own errors: they propagate to the host, which reports them with the flags.
// https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
export function isPlatformFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const flags = err as { retryable?: unknown; overloaded?: unknown };
  return flags.retryable === true || flags.overloaded === true;
}
