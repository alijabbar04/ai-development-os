export const CONTROL_PRESENTATION_MODES = Object.freeze(["normal", "developer"] as const);
export type ControlPresentationMode = (typeof CONTROL_PRESENTATION_MODES)[number];

export interface ControlRouteDefinition {
  readonly method: "GET";
  readonly path: string;
  readonly authenticated: boolean;
  readonly checkpoint: "C4" | "C5";
}

const C4_ROUTES: readonly ControlRouteDefinition[] = [
  Object.freeze({ method: "GET", path: "/v1/health", authenticated: false, checkpoint: "C4" }),
  Object.freeze({ method: "GET", path: "/v1/session", authenticated: true, checkpoint: "C4" }),
];

export const CONTROL_ROUTE_REGISTRY: readonly ControlRouteDefinition[] = Object.freeze(C4_ROUTES);
export const CONTROL_COMMAND_REGISTRY: readonly never[] = Object.freeze([]);
export const CONTROL_ROUTE_COUNT = 2 as const;
export const CONTROL_COMMAND_COUNT = 0 as const;

export interface ControlAuthority {
  readonly productionEnabled: false;
  readonly routeCount: number;
  readonly commandCount: 0;
  readonly routes: readonly ControlRouteDefinition[];
}

const READ_ONLY_AUTHORITY: ControlAuthority = Object.freeze({
  productionEnabled: false,
  routeCount: CONTROL_ROUTE_COUNT,
  commandCount: CONTROL_COMMAND_COUNT,
  routes: CONTROL_ROUTE_REGISTRY,
});

export function controlAuthorityForPresentationMode(mode: ControlPresentationMode): ControlAuthority {
  if (!CONTROL_PRESENTATION_MODES.includes(mode)) throw new TypeError("Unsupported presentation mode.");
  return READ_ONLY_AUTHORITY;
}
