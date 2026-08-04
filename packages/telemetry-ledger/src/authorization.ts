import type { TelemetryAuthorizationRequest, TelemetryAuthorizer } from "./types.js";

export const denyAllTelemetryAuthorizer: TelemetryAuthorizer = Object.freeze({
  authorize: () => false,
});

/**
 * Minimal deny-by-default scope authorizer for trusted local composition.
 * A caller may query only its own subject and exact non-null hierarchy.
 */
export function createExactScopeTelemetryAuthorizer(): TelemetryAuthorizer {
  return Object.freeze({
    authorize(request: TelemetryAuthorizationRequest) {
      return request.scope.userId === request.access.subjectId &&
        request.scope.organizationId === request.access.organizationId &&
        request.scope.projectId === request.access.projectId &&
        request.scope.workspaceId === request.access.workspaceId;
    },
  });
}
