import type { Entity } from "@emulators/core";

export interface ContextLogo {
  url: string;
  type?: string;
}

export interface ContextColor {
  hex: string;
}

/** A company profile keyed by its primary web domain, as Context resolves it. */
export interface ContextBrand extends Entity {
  domain: string;
  title: string | null;
  description: string | null;
  logos: ContextLogo[];
  colors: ContextColor[];
  /** Context returns `partial: true` while enrichment is still running. The
   *  caller is expected to retry rather than cache the incomplete answer. */
  partial: boolean;
}
