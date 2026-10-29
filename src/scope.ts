import type { SessionAuthContext } from 'eve/context'
import type { MemoryScopeContext } from 'eve/memory'

/**
 * The first component of every {@link byTenant} scope. It marks the scope as
 * multi-tenant, so a provider holding a token, which would run every tenant as
 * one shared identity, refuses it rather than share memory across tenants.
 */
export const TENANT_SCOPE = '@memco/eve:tenant'

/** Names the tenant a user principal acts under, or `null` for none. */
export type TenantResolver = (
  principal: SessionAuthContext
) => string | null | undefined | Promise<string | null | undefined>

/**
 * A multi-tenant scope: every user of one tenant shares that tenant's memory.
 *
 * The scope is the tenant, marked as one with {@link TENANT_SCOPE}, and needs
 * an API client's credentials. Memory is off, and eve calls no provider, for a
 * turn with no principal, a principal that is not a user, or a user whose
 * tenant the resolver cannot name. Never resolve the tenant from anything the
 * model supplies.
 *
 * @param resolveTenant Names the tenant of an authenticated user principal,
 *   e.g. from a verified token attribute.
 * @returns A scope resolver for `defineMemory({ scope })`.
 *
 * @example
 * ```ts
 * scope: byTenant(principal => {
 *   const tenant = principal.attributes.tenantId
 *   return typeof tenant === 'string' ? tenant : null
 * })
 * ```
 */
export function byTenant(
  resolveTenant: TenantResolver
): (
  context: MemoryScopeContext
) => Promise<readonly [typeof TENANT_SCOPE, string] | null> {
  return async context => {
    const principal = context.session.auth.current
    if (principal?.principalType !== 'user') {
      return null
    }
    const tenant = await resolveTenant(principal)
    return typeof tenant === 'string' && tenant !== ''
      ? [TENANT_SCOPE, tenant]
      : null
  }
}
