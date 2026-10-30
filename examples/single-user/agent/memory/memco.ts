// Shared-identity mode: MEMCO_API_TOKEN is set, and every caller of this
// deployment shares the token's memco identity and memory.
import { memco } from '@memco/eve'
import { defineMemory } from 'eve/memory'
import { byPrincipal } from 'eve/memory/scope'

export default defineMemory({
  description:
    "The team's shared memory: search it before working something out.",
  provider: memco({ domain: 'knowledge' }),
  // Unique within your memco organisation, and set before launch: changing it
  // starts every caller from empty.
  namespace: 'acme-support-agent',
  scope: byPrincipal
})
