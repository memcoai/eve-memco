import { createHash } from 'node:crypto'

import type { SessionAuthContext } from 'eve/context'

/**
 * Hash the parts as one JSON array. The array encodes each part with its
 * boundaries, so (`acme1`, `23`) and (`acme`, `123`) never hash alike, as a
 * plain concatenation would.
 */
function digest(parts: readonly (string | null)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * The Memco external id of one principal of one tenant.
 *
 * It names the parts eve's `byPrincipal` scope uses, with a missing issuer
 * as `null`, as eve encodes it. The tenant is part of it because an external
 * user sits in one network per domain: without it, a principal under two
 * tenants would be moved between their networks. The namespace is part of it
 * so two apps in one Memco organization never share a user.
 *
 * Changing this derivation is a data migration: every existing user is
 * orphaned.
 *
 * @param namespace The slot's resolved namespace, `ctx.memory.scope.namespace`.
 * @param tenantId The tenant the principal acts under.
 * @param principal The authenticated caller of the turn.
 * @returns `eve-` and 64 hex digits; no personal data.
 */
export function externalId(
  namespace: string,
  tenantId: string,
  principal: SessionAuthContext
): string {
  return `eve-${digest([
    namespace,
    tenantId,
    principal.principalType,
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalId
  ])}`
}

/**
 * The name of one tenant's Memco network in one domain.
 *
 * Network names are unique across an organization's domains, so the domain
 * is part of the name. The hash keeps long or sensitive tenant ids out of the
 * service and fixes the length within a domain.
 *
 * Changing this derivation is a data migration: every tenant's existing
 * network, and the memory in it, is orphaned.
 *
 * @param namespace The slot's resolved namespace, `ctx.memory.scope.namespace`.
 * @param tenantId The tenant the network serves.
 * @param domain The Memco memory domain.
 * @returns `eve-<domain>-` and 64 hex digits.
 */
export function networkName(
  namespace: string,
  tenantId: string,
  domain: string
): string {
  return `eve-${domain}-${digest([namespace, tenantId])}`
}
