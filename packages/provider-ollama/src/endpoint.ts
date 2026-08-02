import { unsafeEndpointError } from "./errors.js";

/**
 * Loopback-only endpoint validation.
 *
 * Stage 7 autonomous operation accepts ONLY literal loopback endpoints:
 *
 * - `http://127.0.0.0/8` IPv4 loopback addresses written as plain dotted
 *   decimal without leading zeros (no octal, hex, integer, or mixed forms);
 * - `http://[::1]` IPv6 loopback written exactly as `[::1]`.
 *
 * Everything else is rejected, including: `localhost` and every other DNS
 * name (resolution and rebinding make names ambiguous), `0.0.0.0`, `::`,
 * IPv4-mapped IPv6 forms, LAN and public addresses, non-http schemes,
 * URL user information, query strings, fragments, and any base path.
 * The raw string is validated by a strict grammar FIRST and then
 * cross-checked against the WHATWG URL parser, so parser normalization
 * (for example `http://0177.0.0.1` -> `127.0.0.1`) can never launder an
 * encoded host trick through validation.
 */
export interface OllamaEndpoint {
  /** Canonical origin, e.g. "http://127.0.0.1:11434" — never ends with "/". */
  readonly baseUrl: string;
  readonly hostname: string;
  readonly port: number;
  readonly family: "ipv4-loopback" | "ipv6-loopback";
}

const MAX_ENDPOINT_LENGTH = 256;

// Plain dotted-decimal octet without leading zeros: 0-255.
const OCTET = "(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])";
const STRICT_ENDPOINT_PATTERN = new RegExp(
  `^http://(?:(127\\.${OCTET}\\.${OCTET}\\.${OCTET})|(\\[::1\\]))(?::([0-9]{1,5}))?/?$`,
);

export function parseOllamaEndpoint(value: unknown): OllamaEndpoint {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw unsafeEndpointError("not-a-bounded-string");
  }
  const match = STRICT_ENDPOINT_PATTERN.exec(value);
  if (match === null) {
    throw unsafeEndpointError("not-literal-loopback");
  }
  const ipv4 = match[1];
  const portText = match[3];
  let port = 80;
  if (portText !== undefined) {
    port = Number.parseInt(portText, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || /^0/.test(portText)) {
      throw unsafeEndpointError("invalid-port");
    }
  }

  // Defense in depth: the WHATWG parser must agree exactly with the strict
  // grammar. Any disagreement (userinfo, query, fragment, path, host
  // normalization) rejects the endpoint.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unsafeEndpointError("unparsable-url");
  }
  const expectedHostname = ipv4 !== undefined ? ipv4 : "[::1]";
  if (
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    // The URL parser omits the default port (80) from `host`.
    parsed.host !== (portText === undefined || port === 80 ? expectedHostname : `${expectedHostname}:${port}`)
  ) {
    throw unsafeEndpointError("url-parser-disagreement");
  }

  const hostname = expectedHostname;
  const baseUrl = `http://${hostname}:${port}`;
  return Object.freeze({
    baseUrl,
    hostname,
    port,
    family: ipv4 !== undefined ? ("ipv4-loopback" as const) : ("ipv6-loopback" as const),
  });
}

/** True when the value parses as an accepted literal loopback endpoint. */
export function isLoopbackOllamaEndpoint(value: unknown): boolean {
  try {
    parseOllamaEndpoint(value);
    return true;
  } catch {
    return false;
  }
}
