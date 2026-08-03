import { unsafeEndpointError } from "./errors.js";

/**
 * Fixed first-party HTTPS endpoint profiles.
 *
 * Stage 11 deliberately does NOT accept arbitrary base URLs: a configurable
 * upstream would turn this adapter into a general proxy and would let a
 * configuration change silently redirect credentials and prompts to a third
 * party. Curated additional upstreams are Stage 12's concern.
 *
 * The only profile is the official server declared by the OpenAI OpenAPI
 * document (`servers: [{ url: https://api.openai.com/v1 }]`). It is exact,
 * HTTPS-only, and redirect-free; the transport rejects any 3xx before a
 * second request can be issued.
 */
export const OPENAI_ENDPOINT_PROFILES = Object.freeze({
  "openai-api": Object.freeze({
    profile: "openai-api",
    baseUrl: "https://api.openai.com/v1",
    hostname: "api.openai.com",
    port: 443,
    basePath: "/v1",
  }),
} as const);

export type OpenAiEndpointProfileName = keyof typeof OPENAI_ENDPOINT_PROFILES;

export interface OpenAiEndpoint {
  readonly profile: OpenAiEndpointProfileName;
  /** Canonical origin + base path; never ends with "/". */
  readonly baseUrl: string;
  readonly hostname: string;
  readonly port: number;
  readonly basePath: string;
}

export const OPENAI_ENDPOINT_PROFILE_NAMES = Object.freeze(
  Object.keys(OPENAI_ENDPOINT_PROFILES).sort() as readonly OpenAiEndpointProfileName[],
);

export const DEFAULT_OPENAI_ENDPOINT_PROFILE: OpenAiEndpointProfileName = "openai-api";

const MAX_ENDPOINT_LENGTH = 256;

function profileByBaseUrl(value: string): OpenAiEndpoint | null {
  for (const name of OPENAI_ENDPOINT_PROFILE_NAMES) {
    const candidate = OPENAI_ENDPOINT_PROFILES[name];
    if (candidate.baseUrl === value) {
      return Object.freeze({ ...candidate });
    }
  }
  return null;
}

/**
 * Resolves an endpoint from either a profile name or the exact canonical
 * base URL of a known profile.
 *
 * Rejected: non-HTTPS schemes, URL user information, any host other than a
 * known profile host, non-default ports, query strings, fragments, trailing
 * or alternate paths, percent-encoded host tricks, and unknown profiles.
 * The strict grammar runs FIRST and the WHATWG parser must then agree
 * exactly, so parser normalization can never launder a hostile host.
 */
export function parseOpenAiEndpoint(value: unknown): OpenAiEndpoint {
  // Accept an already-parsed endpoint so validating a round-tripped
  // configuration is well defined. Only the profile name is trusted; every
  // other field is re-derived from the fixed table.
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const profile = (value as { profile?: unknown }).profile;
    const known =
      typeof profile === "string"
        ? (OPENAI_ENDPOINT_PROFILES as Record<string, OpenAiEndpoint | undefined>)[profile]
        : undefined;
    if (known === undefined) {
      throw unsafeEndpointError("not-a-known-first-party-endpoint");
    }
    return Object.freeze({ ...known });
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw unsafeEndpointError("not-a-bounded-string");
  }

  const asProfile = (OPENAI_ENDPOINT_PROFILES as Record<string, OpenAiEndpoint | undefined>)[value];
  if (asProfile !== undefined) {
    return Object.freeze({ ...asProfile });
  }

  if (!value.startsWith("https://")) {
    throw unsafeEndpointError("not-https");
  }
  const matched = profileByBaseUrl(value);
  if (matched === null) {
    throw unsafeEndpointError("not-a-known-first-party-endpoint");
  }

  // Defense in depth: the WHATWG parser must agree exactly with the fixed
  // profile. Any disagreement rejects the endpoint.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unsafeEndpointError("unparsable-url");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname !== matched.hostname ||
    // The URL parser omits the default port (443) from `host`.
    parsed.host !== matched.hostname ||
    parsed.pathname !== matched.basePath
  ) {
    throw unsafeEndpointError("url-parser-disagreement");
  }
  return matched;
}

/** True when the value resolves to an accepted first-party endpoint. */
export function isOpenAiEndpoint(value: unknown): boolean {
  try {
    parseOpenAiEndpoint(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The finite set of routes this adapter uses. Every request URL is built
 * from a validated endpoint plus one of these routes; caller-supplied paths
 * are unrepresentable. Administrative and write endpoints are absent.
 */
export const OPENAI_ROUTES = Object.freeze({
  createResponse: Object.freeze({ method: "POST", path: "/responses" }),
  getResponse: Object.freeze({ method: "GET", path: "/responses/{id}" }),
  cancelResponse: Object.freeze({ method: "POST", path: "/responses/{id}/cancel" }),
  streamResponse: Object.freeze({ method: "GET", path: "/responses/{id}" }),
} as const);

export type OpenAiRouteName = keyof typeof OPENAI_ROUTES;

/**
 * OpenAI response identifiers are opaque; this adapter accepts only a
 * conservative bounded shape so a hostile id can never alter the request
 * path or inject query parameters.
 */
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,120}$/;

export function parseOpenAiResponseId(value: unknown): string {
  if (typeof value !== "string" || !RESPONSE_ID_PATTERN.test(value)) {
    throw unsafeEndpointError("invalid-response-id");
  }
  return value;
}

export interface RouteQuery {
  readonly stream?: boolean;
  readonly startingAfter?: number;
}

/**
 * Builds an absolute request URL from a validated endpoint, a fixed route,
 * a validated response id, and a bounded, enumerated query. Query values
 * are numbers/booleans only, so no caller string ever reaches the URL.
 */
export function buildOpenAiUrl(
  endpoint: OpenAiEndpoint,
  route: OpenAiRouteName,
  options: { readonly responseId?: string; readonly query?: RouteQuery } = {},
): string {
  const template: string = OPENAI_ROUTES[route].path;
  let path: string = template;
  if (template.includes("{id}")) {
    if (options.responseId === undefined) {
      throw unsafeEndpointError("missing-response-id");
    }
    path = template.replace("{id}", parseOpenAiResponseId(options.responseId));
  } else if (options.responseId !== undefined) {
    throw unsafeEndpointError("unexpected-response-id");
  }

  const query = options.query;
  const parameters: string[] = [];
  if (query?.stream === true) {
    parameters.push("stream=true");
  }
  if (query?.startingAfter !== undefined) {
    if (!Number.isSafeInteger(query.startingAfter) || query.startingAfter < 0) {
      throw unsafeEndpointError("invalid-starting-after");
    }
    parameters.push(`starting_after=${query.startingAfter}`);
  }
  const search = parameters.length === 0 ? "" : `?${parameters.join("&")}`;
  return `${endpoint.baseUrl}${path}${search}`;
}
