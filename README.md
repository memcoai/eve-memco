# @memco/eve

[Memco Shared Memory](https://memco.ai) as a memory provider for [eve](https://github.com/vercel/eve)
agents. The agent searches what your team already knows before working something out, and saves
what it learns so nobody has to learn it twice.

```sh
npm i @memco/eve
```

It needs eve as a peer and Node 24 or later.

## Set up

Add a memory slot, `agent/memory/memco.ts`, and set the credential in the environment. The
credential decides the mode.

### Single-user: one token

Every caller of the deployment shares one Memco identity, and its memory.

```ts
import { memco } from '@memco/eve'
import { defineMemory } from 'eve/memory'
import { byPrincipal } from 'eve/memory/scope'

export default defineMemory({
  description:
    "The team's shared memory: search it before working something out.",
  provider: memco({ domain: 'knowledge' }),
  namespace: 'acme-support-agent',
  scope: byPrincipal
})
```

| Variable          | Value             |
| ----------------- | ----------------- |
| `MEMCO_API_TOKEN` | A Memco API token |

### Multi-tenant: one API client

Each tenant gets its own Memco network, and each of its users an external user placed in it. The
users of one tenant share that tenant's memory, and never see another's. Scope the slot with
`byTenant`, which names the tenant from the verified sign-in, never from the model:

```ts
import { byTenant, memco } from '@memco/eve'
import { defineMemory } from 'eve/memory'

export default defineMemory({
  description:
    "Your organization's shared memory: search it before working something out.",
  provider: memco({ domain: 'knowledge' }),
  namespace: 'acme-support-agent',
  scope: byTenant(principal => {
    const tenant = principal.attributes['tenantId']
    return typeof tenant === 'string' ? tenant : null
  })
})
```

| Variable                                 | Value                                                  |
| ---------------------------------------- | ------------------------------------------------------ |
| `MEMCO_CLIENT_ID`, `MEMCO_CLIENT_SECRET` | A Memco API client granted network and user management |

`byTenant` turns memory off, and eve calls no provider, for a caller that is not a signed-in user
or whose tenant the resolver cannot name. That includes eve's local development principal.

A `byTenant` slot needs the API client. With a token instead, every tenant would share one Memco
identity, so the provider fails the turn rather than run.

Both examples are in [`examples/`](examples/).

### Options

`memco(options)` takes the Memco client's own options (`host`, `timeout`, `token`, `clientId`,
`clientSecret`, ...), each falling back to the environment as the client does, and:

| Option          | Default     | Meaning                                                       |
| --------------- | ----------- | ------------------------------------------------------------- |
| `domain`        | `knowledge` | The Memco memory domain the slot reads and writes             |
| `keyTtlMinutes` | `10`        | Lifetime of the key a multi-tenant turn acts as its user with |

## What the agent gets

- **A briefing on the first turn** of a Memco session: the domain's guidance (when to search, what
  to save, which tags to use) and the session's instructions. It is recalled once, under the id
  `memco-briefing`, and stays in context.
- **A nudge on every turn**, beside the turn's input, to search memory before working.
- **The memory tools**, named after the slot: `memco__search`, `memco__get_memory`,
  `memco__create_memory`, `memco__enrich_memory`, `memco__share_feedback` and
  `memco__revert_memory`, as the credential's role allows. Their descriptions and results name
  the tools the same way.

Nothing is captured from the conversation: the agent writes to memory only through the tools.

When Memco is unavailable or times out, the turn goes on without memory and the provider logs
why. An authentication, permission or configuration error fails the turn, so a misconfiguration is
never mistaken for an outage.

## The namespace

Each tenant's network and users are named from eve's namespace, so set an explicit `namespace` in
production:

- **Unique per app** within your Memco organization, for instance containing the app's name. Two
  apps sharing a namespace share every tenant's memory.
- **Set before launch.** Changing it later starts every tenant from empty. eve's default
  namespace includes the slot's file name, so without an explicit one, renaming the slot does the
  same.
- **Preview deployments** get their own namespace, and so their own networks and users, per
  branch with traffic. Nothing removes those. Use a separate Memco organization or API client for
  Preview, or a namespace resolver that returns `null` there.

## The Memco calls a turn makes

Sized for your plan. A multi-tenant turn acts as the tenant's user with a key minted for the turn
and ended when it completes. eve keeps the provider's state per conversation, so a user's first
turn in each conversation provisions again: creating a user or network that already exists costs a
second call to find it, and adding a member already in the network changes nothing.

| Turn                                  | Calls                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| First of a conversation, multi-tenant | Create (or find) the external user and the tenant network, add the user to it; mint a key; `ListDomains`, `StartSession`, `ListTools`; end the key |
| Every later one, multi-tenant         | Mint a key; `ListDomains`, `GetSession`, `ListTools`; end the key                                                                                  |
| First of a conversation, single-user  | `ListDomains`, `StartSession`, `ListTools`                                                                                                         |
| Every later one, single-user          | `ListDomains`, `GetSession`, `ListTools`                                                                                                           |

Each tool the model calls is one more. In multi-tenant mode the API client also exchanges its
credentials for a token, once and then as it expires. All of a deployment's tenants share the API
client's rate limits.

Deleting a tenant's memory is a call you make yourself, `client.networks.delete(networkId)` with
the [Memco SDK](https://www.npmjs.com/package/@memco/memcoai).

## Development

```sh
make install   # npm ci
make check     # lint, typecheck, test
```

## License

MIT
