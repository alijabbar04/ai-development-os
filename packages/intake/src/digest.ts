import { computeChecksumOfText } from "@ai-dev-os/persistence";
import type { IntakeDigestPort } from "./contracts.js";

/** Repository-owned SHA-256 implementation; pure engines still receive it as a port. */
export const intakeSha256: IntakeDigestPort = Object.freeze({
  sha256: (text: string): string => computeChecksumOfText(text).hex,
});
