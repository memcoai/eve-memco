# memco for eve

Shared memory for [eve](https://github.com/vercel/eve) agents. Make useful knowledge from one task
available to later conversations and other users sharing that memory.

`@memco/eve` connects your agent to [memco](https://memco.ai). Agents can search existing knowledge,
save findings, enrich memories and report whether they helped. For example, an agent can save a
support workaround that another agent serving the same customer can reuse.

Use one API token for a shared memco identity, or an API client to give each tenant its own memory
network. The provider supplies memory guidance and tools; it does not automatically capture
conversation transcripts.

## Requirements and installation

You need Node.js 24 or later, an existing eve app using `eve >=0.84.1 <1`, and a memco account. If
you are starting a new app, follow [eve's first-agent tutorial](https://eve.dev/docs/tutorial/first-agent).

Install the provider in your eve app:

```sh
npm i @memco/eve
```

Create an API token in the [memco dashboard](https://spark.memco.ai/) for the shared-identity
quickstart below. For a multi-tenant app, use an API client with network and user management
permissions and the admin grant to act for your users; see the
[credential guide](https://docs.memco.ai/sdk/embedding-memory/#managing-networks-and-users).

Keep credentials on the server. Choose one credential set: API client credentials take precedence
when both they and an API token are set in the environment.

## Quickstart: shared identity

Every caller of this deployment uses the token's memco identity and shares the memory it can
access. Use this mode for a personal agent or one trusted audience, not for separate customers.

Set the token in your deployment's environment, or in an uncommitted `.env.local` for `eve dev`:

```dotenv
MEMCO_API_TOKEN=replace-with-your-memco-api-token
```

Add the memory slot at `agent/memory/memco.ts`:

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

`byPrincipal` scopes eve's use of the slot; it does not create separate memco identities or isolate
callers' stored memories when they use one token. For tenant isolation, use the
[multi-tenant setup](#multi-tenant-setup) below.

### Verify your setup

Use a test account or network for this check so the example does not enter production memory.
Start your agent with tool inputs and results visible:

```sh
npx eve dev --tools full
```

1. Ask: "Save this test fact in memco: the sandbox support demo uses the escalation code
   cobalt-orchid. This is test data, not a real support policy." Confirm that
   `memco__create_memory` runs and its result reports success.
2. Enter `/reset` in eve's terminal UI to start a fresh session, then ask: "Search memco for the
   sandbox support demo's escalation code." Confirm that `memco__search` returns the saved fact.
   An answer from the model alone is not evidence that memory worked.
3. After using a real memory on a task, ask the agent to report whether it helped through
   `memco__share_feedback`. That feedback is part of the learning loop, alongside creating and
   enriching memories.

The fresh session checks persistence beyond conversation history. See
[eve's terminal UI guide](https://eve.dev/docs/guides/dev-tui) for tool display and logs. If tools
are missing, check the active credential, its role and access to the `knowledge` domain, and the
provider's `[@memco/eve]` logs.

## Multi-tenant setup

Each tenant gets its own memco network, and each of its users an external user placed in it. Users
within a tenant share that tenant's memory. The provider derives tenant and user identities from
verified sign-in, never from the model.

Set your API client's credentials in the server environment:

```dotenv
MEMCO_CLIENT_ID=replace-with-your-api-client-id
MEMCO_CLIENT_SECRET=replace-with-your-api-client-secret
```

Use this definition in `agent/memory/memco.ts` instead of the shared-identity example:

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

Your authentication integration must supply the verified `tenantId` attribute; adapt the resolver
to your sign-in system. `byTenant` turns memory off, and eve calls no provider, for a caller that is
not a signed-in user or whose tenant the resolver cannot name. That includes eve's local development
principal: test this mode through a channel with authenticated users, not the unauthenticated local
terminal session.

A `byTenant` slot needs the API client. With a token instead, every tenant would share one memco
identity, so the provider fails the turn rather than run.

To check sharing and isolation, save a test fact as one user, then search for it in a new session
as another user in the same tenant. It should be available there. A user in a different tenant must
not be able to retrieve that tenant's memory, including by its ID with `memco__get_memory`. Inspect
tool results, not just the agent's answer; a search miss alone does not establish access isolation.

Both slot definitions are in [`examples/`](examples/).

## Memory behaviour

The provider adds guidance and tools to the agent's normal turn lifecycle:

- On the first turn of a memco session, a briefing supplies the domain's guidance (when to search,
  what to save, which tags to use) and the session's instructions. It is recalled once, under the id
  `memco-briefing`, and stays in context.
- On every turn, a nudge beside the turn's input asks the agent to search memory before working.
- The slot exposes `memco__search`, `memco__get_memory`, `memco__create_memory`,
  `memco__enrich_memory`, `memco__share_feedback` and `memco__revert_memory`, as the credential's
  role allows. The `memco__` prefix comes from the slot's file name; tool descriptions and results
  use the same names.

The agent decides when to call the tools. Searching is encouraged, not enforced, and writes happen
only through tool calls. Tool inputs, including search queries and memory content, are sent to
memco; the provider does not automatically upload the conversation transcript. Set your agent's
instructions to exclude secrets and other content that should not become shared memory.

## Options

`memco(options)` takes the memco client's own options (`host`, `timeout`, `token`, `clientId`,
`clientSecret`, ...), each falling back to the environment as the client does, and:

| Option          | Default     | Meaning                                                                      |
| --------------- | ----------- | ---------------------------------------------------------------------------- |
| `domain`        | `knowledge` | The memco memory domain the slot reads and writes                            |
| `keyTtlMinutes` | `10`        | Lifetime, in whole minutes, of the key a multi-tenant turn uses for its user |

See the [SDK configuration reference](https://docs.memco.ai/sdk/#configuration) for client
settings and environment variables.

## Production considerations

### Namespaces and preview deployments

In multi-tenant mode, each tenant's network and users are named from eve's namespace. Set an
explicit, stable `namespace` before launch:

- Make it unique per app within your memco organisation. Apps using the same namespace, tenant ID
  and domain address the same tenant network.
- Changing it starts tenants in newly named networks without their existing memory. eve's default
  namespace includes the slot's file name, so without an explicit one, renaming the slot does the
  same. This does not delete the old networks.
- With eve's default namespace, Preview deployments get separate networks and users per branch
  with traffic. Nothing removes those automatically. An explicit namespace is used as-is, with no
  environment suffix: do not reuse the production namespace and organisation for Preview. Use a
  separate memco organisation, or a namespace resolver that returns a distinct preview namespace
  or `null` there. See [eve's namespace rules](https://eve.dev/docs/memory#namespace).

A namespace does not partition the token's stored memory in shared-identity mode.

### Failure behaviour

During recall and tool setup, a memco outage or timeout leaves the turn without memory and the
provider logs why. Authentication, permission and configuration errors are not treated as outages:
those errors propagate rather than silently disabling memory. Errors from executing a memory tool
or closing its session also propagate; the setup fallback does not cover every call in a turn.

### API calls and rate limits

A multi-tenant turn acts as the tenant's user with a key minted for the turn and ended when it
completes. eve keeps the provider's state per conversation, so a user's first turn in each
conversation provisions again: creating a user or network that already exists costs a second call
to find it, and adding a member already in the network changes nothing.

| Turn                                     | Calls                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| First of a conversation, multi-tenant    | Create (or find) the external user and the tenant network, add the user to it; mint a key; `ListDomains`, `StartSession`, `ListTools`; end the key |
| Every later one, multi-tenant            | Mint a key; `ListDomains`, `GetSession`, `ListTools`; end the key                                                                                  |
| First of a conversation, shared identity | `ListDomains`, `StartSession`, `ListTools`                                                                                                         |
| Every later one, shared identity         | `ListDomains`, `GetSession`, `ListTools`                                                                                                           |

Each tool the model calls is one more. In multi-tenant mode the API client also exchanges its
credentials for a token, once and then as it expires. All of a deployment's tenants share the API
client's rate limits.

Deleting a tenant's memory is a call you make yourself, `client.networks.delete(networkId)` with
the [memco SDK](https://www.npmjs.com/package/@memco/memcoai).

## Development

From a checkout of this repository, using Node.js 24 or later:

```sh
make install   # npm ci
make check     # lint, typecheck, test
```

## Licence

[MIT](LICENSE)
