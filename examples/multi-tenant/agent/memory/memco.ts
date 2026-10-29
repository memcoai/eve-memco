// Multi-tenant mode: MEMCO_CLIENT_ID and MEMCO_CLIENT_SECRET are set. Each
// tenant gets its own Memco network, and each of its users an external user
// placed in it, so the users of one tenant share that tenant's memory and
// never another's.
import { byTenant, memco } from '@memco/eve'
import { defineMemory } from 'eve/memory'

export default defineMemory({
  description:
    "Your organization's shared memory: search it before working something out.",
  provider: memco({ domain: 'knowledge' }),
  // Unique within your Memco organization, and set before launch: changing it
  // starts every tenant from empty.
  namespace: 'acme-support-agent',
  // The tenant comes from the verified sign-in, never from the model. A caller
  // that is not a signed-in user of a tenant gets no memory.
  scope: byTenant(principal => {
    const tenant = principal.attributes['tenantId']
    return typeof tenant === 'string' ? tenant : null
  })
})
