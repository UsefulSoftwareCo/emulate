const BRAND = Symbol.for("@emulators/core/ControlPlaneRejection");

// A seed or credential request the emulator refuses on its own terms (an
// unsupported credential type, an invalid OAuth client). The control plane
// answers these with a 400 and their message, which the emulator wrote. Any
// other error from a seed or credential request is unexpected, such as a host
// storage failure, and goes to the app's error handler instead; on Cloudflare
// that is a redacted failure report, since a raw message can quote anything.
export class ControlPlaneRejection extends Error {
  readonly [BRAND] = true;

  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneRejection";
  }

  // Checked by brand, not `instanceof`: emulator packages can load their own
  // copy of core.
  static is(err: unknown): err is ControlPlaneRejection {
    return typeof err === "object" && err !== null && (err as { [BRAND]?: unknown })[BRAND] === true;
  }
}
