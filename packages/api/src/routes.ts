import { validation } from "@ai-dev-os/domain";
import { API_PRODUCTION_ENABLED } from "./constants.js";

export const API_ROUTE_REGISTRY: readonly never[] = Object.freeze([]);
export const API_COMMAND_REGISTRY: readonly never[] = Object.freeze([]);
export const API_ROUTE_COUNT = 0 as const;
export const API_COMMAND_COUNT = 0 as const;

export const API_PRESENTATION_MODES = Object.freeze(["normal", "developer"] as const);
export type ApiPresentationMode = (typeof API_PRESENTATION_MODES)[number];

export interface ApiContractAuthority {
  readonly productionEnabled: false;
  readonly routeCount: 0;
  readonly commandCount: 0;
}

const ROUTE_FREE_AUTHORITY: ApiContractAuthority = Object.freeze({
  productionEnabled: API_PRODUCTION_ENABLED,
  routeCount: API_ROUTE_COUNT,
  commandCount: API_COMMAND_COUNT,
});

export function apiAuthorityForPresentationMode(value: unknown): ApiContractAuthority {
  validation.ensureEnum(value, "presentationMode", API_PRESENTATION_MODES);
  return ROUTE_FREE_AUTHORITY;
}
