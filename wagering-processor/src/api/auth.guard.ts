import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

/**
 * Authentication extension point (challenge section 2 — deliberately not
 * implemented; see ARCHITECTURE.md).
 *
 * The intended design integrates an external Identity Provider (Keycloak or
 * Zitadel via OIDC client-credentials): this guard would validate the Bearer
 * JWT (issuer/audience/signature via JWKS), extract the provider identity
 * from a claim and cross-check it against the providerId in the payload.
 * Health endpoints stay open; queue messages are an internal trusted channel
 * whose provider identity is still subject to the same domain validations.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true; // no-op: every request is let through
  }
}
