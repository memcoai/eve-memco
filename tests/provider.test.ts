import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionAuthContext } from 'eve/context'
import type {
  MemoryToolsContext,
  MemoryTurnCompletedContext,
  MemoryTurnStartedContext
} from 'eve/memory'

import { externalId, networkName } from '../src/derive.js'
import { TENANT_SCOPE } from '../src/scope.js'
import { MemcoConfigError } from '@memco/memcoai'

import {
  createProvider,
  memco,
  type SessionState,
  type UserNameResolver,
  type StoredSessions
} from '../src/provider.js'
import {
  FakeMemco,
  denied,
  timedOut,
  unavailable,
  unhealthy
} from './fakeMemco.js'

function user(principalId = 'user-1'): SessionAuthContext {
  return {
    attributes: {},
    authenticator: 'oidc',
    principalId,
    principalType: 'user'
  }
}

/** A plain object standing in for eve's `defineState` handle. */
function store(initial: StoredSessions = {}): SessionState & {
  value: StoredSessions
} {
  const state = {
    value: initial,
    get: () => state.value,
    update: (fn: (current: StoredSessions) => StoredSessions) => {
      state.value = fn(state.value)
    }
  }
  return state
}

interface Turn {
  eveSession?: string
  turnId?: string
  tenant?: string
  principal?: SessionAuthContext
  scopeValue?: string | readonly string[]
  sequence?: number
}

type Context = MemoryTurnStartedContext &
  MemoryTurnCompletedContext &
  MemoryToolsContext

/** A hand-built eve context for one turn, carrying what the provider reads. */
function context({
  eveSession = 'eve-1',
  turnId = 'turn-1',
  tenant = 'tenant-a',
  principal = user(),
  scopeValue = [TENANT_SCOPE, tenant],
  sequence = 1
}: Turn = {}): Context {
  return {
    abortSignal: new AbortController().signal,
    messages: [],
    operationId: 'op-1',
    session: {
      id: eveSession,
      auth: { current: principal, initiator: principal }
    },
    memory: {
      slot: 'memco',
      scope: {
        key: `key-${JSON.stringify(scopeValue)}`,
        namespace: 'app',
        value: scopeValue
      }
    },
    turn: { id: turnId, input: [], sequence }
  } as unknown as Context
}

function setup(
  kind: 'token' | 'apiClient',
  state = store(),
  domain = 'knowledge',
  userName?: UserNameResolver,
  nudgeEvery = 1
) {
  const client = new FakeMemco(kind)
  const logs: string[] = []
  let time = 0
  const provider = createProvider({
    client: () => client,
    state,
    domain,
    keyTtlMinutes: 10,
    nudgeEvery,
    ...(userName === undefined ? {} : { userName }),
    now: () => time,
    log: message => logs.push(message)
  })
  // A token's slot is scoped per principal, as with eve's byPrincipal.
  const turn = (given: Turn = {}) =>
    context(kind === 'token' ? { scopeValue: 'principal-1', ...given } : given)
  const recall = (given?: Turn) => provider.recall['turn.started'](turn(given))
  const tools = (given?: Turn) => provider.tools(turn(given))
  const capture = (given?: Turn) =>
    provider.capture['turn.completed'](turn(given))
  const advance = (minutes: number) => {
    time += minutes * 60_000
  }
  return { client, state, logs, provider, recall, tools, capture, advance }
}

const ADMIN = [
  'users.createOrGet',
  'networks.createOrGet',
  'networks.addMember'
]

// --- mode -------------------------------------------------------------------

test('a token runs a turn with no users, networks or keys created', async () => {
  const { client, recall, tools, capture } = setup('token')
  await recall()
  await tools()
  await capture()
  assert.deepEqual(client.methods(), ['startSession'])
  assert.deepEqual(client.calls[0]?.args, ['knowledge', {}])
  assert.equal(client.sessions[0]?.closed, true)
})

test('an API client provisions the user and the tenant network, then acts as the user', async () => {
  const { client, recall } = setup('apiClient')
  await recall()
  const id = externalId('app', 'tenant-a', user())
  const network = networkName('app', 'tenant-a', 'knowledge')
  assert.deepEqual(client.methods(), [...ADMIN, 'startSession'])
  assert.deepEqual(client.calls[0]?.args, [
    id,
    { roles: ['reader', 'creator'], name: id }
  ])
  assert.deepEqual(client.calls[1]?.args, [
    {
      name: network,
      domain: 'knowledge',
      scope: 'customer',
      owner: network,
      description: 'Eve memory · namespace: app · domain: knowledge'
    }
  ])
  assert.deepEqual(client.calls[2]?.args, [
    `network-${network}`,
    { userId: `user-${id}` }
  ])
  assert.deepEqual(client.calls[3]?.args, [
    'knowledge',
    { externalId: id, keyTtlMinutes: 10 }
  ])
})

test('a byTenant scope with a token fails the turn rather than share memory across tenants', async () => {
  const { client, recall } = setup('token')
  await assert.rejects(
    recall({ scopeValue: [TENANT_SCOPE, 'tenant-a'] }),
    /MEMCO_CLIENT_ID/
  )
  assert.deepEqual(client.calls, [])
})

test('two memco slots on one agent keep their own sessions and domains', async () => {
  const state = store()
  const knowledge = setup('apiClient', state, 'knowledge')
  const coding = setup('apiClient', state, 'coding')
  await knowledge.recall()
  await coding.recall()
  assert.deepEqual(coding.client.methods(), [...ADMIN, 'startSession'])
  assert.equal(coding.client.calls.at(-1)?.args[0], 'coding')
})

test('multi-tenant memory refuses a scope that is not one tenant', async () => {
  const { recall } = setup('apiClient')
  for (const scopeValue of [
    ['tenant-a', 'user-1'],
    'tenant-a',
    [TENANT_SCOPE]
  ]) {
    await assert.rejects(recall({ scopeValue }), /byTenant/)
  }
})

// --- what recall returns ----------------------------------------------------

test('the first turn recalls the briefing and the nudge, a later one only the nudge', async () => {
  const { recall, capture } = setup('apiClient')
  const first = await recall()
  assert.equal(first?.messages.length, 2)
  assert.equal(first?.messages[0]?.id, 'memco-briefing')
  assert.match(first?.messages[0]?.content ?? '', /'knowledge' domain/)
  assert.equal(first?.messages[1]?.id, undefined)
  assert.match(first?.messages[1]?.content ?? '', /memco__search/)
  await capture()

  const later = await recall()
  assert.deepEqual(later?.messages, [first?.messages[1]])
})

test('a session is nudged when it starts and then every nudgeEvery turns', async () => {
  const { recall, capture } = setup(
    'apiClient',
    store(),
    'knowledge',
    undefined,
    3
  )
  const nudged: boolean[] = []
  for (const sequence of [1, 2, 3, 4, 5, 6]) {
    const turn = { sequence, turnId: `turn-${sequence}` }
    const result = await recall(turn)
    nudged.push(
      result?.messages.some(message => message.id === undefined) ?? false
    )
    await capture(turn)
  }
  assert.deepEqual(nudged, [true, false, true, false, false, true])
})

test('nudgeEvery must be a whole number from 1 up', () => {
  for (const nudgeEvery of [0, -1, 1.5]) {
    assert.throws(() => memco({ nudgeEvery }), MemcoConfigError)
  }
})

test('the nudge asks to save lessons, not general knowledge', async () => {
  const { recall } = setup('apiClient')
  const nudge = (await recall())?.messages.at(-1)?.content ?? ''
  assert.match(nudge, /memco__create_memory/)
  assert.match(nudge, /not general knowledge/)
})

test('a session whose domain is not described recalls only the nudge, and says so', async () => {
  const { client, logs, recall } = setup('token')
  client.domain = null
  const result = await recall()
  assert.equal(result?.messages.length, 1)
  assert.equal(result?.messages[0]?.id, undefined)
  assert.match(logs.join('\n'), /briefing/)
})

test('a later turn resumes the stored session and makes no user, network or member calls', async () => {
  const { client, recall, capture } = setup('apiClient')
  await recall()
  await capture()
  client.calls.length = 0
  await recall()
  assert.deepEqual(client.methods(), ['resumeSession'])
  assert.equal(client.calls[0]?.args[0], 'session-1')
})

// --- who the session belongs to ---------------------------------------------

test('the same principal under two tenants is two users, each in its own network', async () => {
  const { client, recall } = setup('apiClient')
  await recall({ tenant: 'tenant-a' })
  await recall({ tenant: 'tenant-b' })
  const users = client.calls.filter(call => call.method === 'users.createOrGet')
  const networks = client.calls.filter(
    call => call.method === 'networks.createOrGet'
  )
  assert.equal(users.length, 2)
  assert.notEqual(users[0]?.args[0], users[1]?.args[0])
  assert.notDeepEqual(networks[0]?.args, networks[1]?.args)
  const members = client.calls.filter(
    call => call.method === 'networks.addMember'
  )
  for (const tenant of ['tenant-a', 'tenant-b']) {
    const id = externalId('app', tenant, user())
    const network = networkName('app', tenant, 'knowledge')
    assert.ok(
      members.some(
        call =>
          call.args[0] === `network-${network}` &&
          (call.args[1] as { userId: string }).userId === `user-${id}`
      ),
      `${tenant}'s user is added to ${tenant}'s network`
    )
  }
})

test('a principal change inside one scope opens a session for the new user', async () => {
  const { client, recall } = setup('apiClient')
  await recall({ principal: user('user-1') })
  await recall({ principal: user('user-2') })
  const starts = client.calls.filter(call => call.method === 'startSession')
  assert.equal(starts.length, 2)
  assert.deepEqual(
    starts.map(call => (call.args[1] as { externalId: string }).externalId),
    [
      externalId('app', 'tenant-a', user('user-1')),
      externalId('app', 'tenant-a', user('user-2'))
    ]
  )
})

test("on a fresh process, tools for one principal use that principal's session and key", async () => {
  const state = store()
  const first = setup('apiClient', state)
  await first.recall({ principal: user('user-1') })
  await first.recall({ principal: user('user-2') })

  const fresh = setup('apiClient', state)
  for (const session of first.client.known) fresh.client.known.add(session)
  await fresh.tools({ principal: user('user-2') })
  assert.deepEqual(fresh.client.methods(), ['resumeSession'])
  assert.deepEqual(fresh.client.calls[0]?.args, [
    'session-2',
    {
      externalId: externalId('app', 'tenant-a', user('user-2')),
      keyTtlMinutes: 10
    }
  ])
})

// --- user names -------------------------------------------------------------

const named = (name: string | null | undefined) =>
  setup('apiClient', store(), 'knowledge', () => name)

test('a new user takes the name the resolver gives', async () => {
  const { client, recall } = named('Ada Lovelace')
  await recall()
  const id = externalId('app', 'tenant-a', user())
  assert.deepEqual(client.calls[0]?.args, [
    id,
    { roles: ['reader', 'creator'], name: 'Ada Lovelace' }
  ])
  assert.deepEqual(client.methods(), [...ADMIN, 'startSession'])
})

test('the resolver is handed the principal of the turn', async () => {
  const seen: string[] = []
  const { recall } = setup('apiClient', store(), 'knowledge', principal => {
    seen.push(principal.principalId)
    return 'name'
  })
  await recall({ principal: user('user-2') })
  assert.deepEqual(seen, ['user-2'])
})

test('a resolver naming nobody leaves the external id as the name', async () => {
  for (const name of [null, undefined, '', '   ']) {
    const { client, recall } = named(name)
    await recall()
    const id = externalId('app', 'tenant-a', user())
    assert.equal((client.calls[0]?.args[1] as { name: string }).name, id)
  }
})

test('a token never asks for a name', async () => {
  let asked = false
  const { recall } = setup('token', store(), 'knowledge', () => {
    asked = true
    return 'name'
  })
  await recall()
  assert.equal(asked, false)
})

// --- the turn's session -----------------------------------------------------

test('tools are offered under bare keys, describing the slot-qualified names', async () => {
  const { recall, tools } = setup('token')
  await recall()
  const offered = await tools()
  assert.deepEqual(Object.keys(offered ?? {}), ['search', 'create_memory'])
  assert.match(offered?.['search']?.description ?? '', /memco__search/)
  const ran = await offered?.['search']?.execute(
    { query: 'x' } as never,
    {} as never
  )
  assert.equal(ran, 'search ran as token: {"query":"x"}')
})

test('every tool is built with defineTool, as eve requires of a provider', async () => {
  const { recall, tools } = setup('token')
  await recall()
  const offered = await tools()
  for (const tool of Object.values(offered ?? {})) {
    assert.equal(
      (tool as unknown as Record<symbol, unknown>)[
        Symbol.for('eve:tool-brand')
      ],
      true
    )
  }
})

test('recall and tools in one turn share one session', async () => {
  const { client, recall, tools } = setup('apiClient')
  await recall()
  await tools()
  await tools()
  assert.equal(client.sessions.length, 1)
})

test('the turn completing closes its session and drops it', async () => {
  const { client, recall, tools, capture } = setup('apiClient')
  await recall()
  await capture()
  assert.equal(client.sessions[0]?.closed, true)
  await tools()
  assert.equal(client.sessions.length, 2)
})

test('two eve sessions of one user each get their own session', async () => {
  const { client, recall, tools, capture } = setup('apiClient')
  await recall({ eveSession: 'eve-1' })
  await recall({ eveSession: 'eve-2' })
  assert.equal(client.sessions.length, 2)
  await capture({ eveSession: 'eve-1' })
  assert.equal(client.sessions[0]?.closed, true)
  assert.equal(client.sessions[1]?.closed, false)
  await tools({ eveSession: 'eve-2' })
  assert.equal(client.sessions.length, 2)
})

// --- recovering -------------------------------------------------------------

test('a stored session the service refuses is replaced, with a new briefing', async () => {
  const { client, state, recall, capture } = setup('apiClient')
  await recall()
  await capture()
  client.known.clear()
  const result = await recall()
  assert.equal(result?.messages[0]?.id, 'memco-briefing')
  assert.deepEqual(client.methods().slice(-2), [
    'resumeSession',
    'startSession'
  ])
  const [entry] = Object.values(state.value)
  assert.equal(entry?.sessionId, 'session-2')
})

test('a deleted network or user is provisioned again once', async () => {
  const { client, recall, capture } = setup('apiClient')
  await recall()
  await capture()
  client.calls.length = 0
  client.failures['resumeSession'] = [denied()]
  await recall()
  assert.deepEqual(client.methods(), [
    'resumeSession',
    ...ADMIN,
    'startSession'
  ])
})

test('provisioning again fails the turn when the session still cannot open', async () => {
  const { client, recall, capture } = setup('apiClient')
  await recall()
  await capture()
  client.failures['resumeSession'] = [denied()]
  client.failures['startSession'] = [denied()]
  await assert.rejects(recall(), { name: 'MemcoPermissionError' })
})

test('an outage leaves the turn without memory, and says so', async () => {
  for (const failure of [unavailable, unhealthy, timedOut]) {
    const { client, logs, recall, tools } = setup('token')
    client.failures['startSession'] = [failure(), failure()]
    assert.equal(await recall(), null)
    assert.equal(await tools(), null)
    assert.equal(logs.length, 2)
  }
})

test('a refusal that is not an outage fails the turn', async () => {
  const { client, recall } = setup('token')
  client.failures['startSession'] = [denied()]
  await assert.rejects(recall(), { name: 'MemcoPermissionError' })
})

test('a failed open is not cached, so the next call tries again', async () => {
  const { client, recall } = setup('token')
  client.failures['startSession'] = [unavailable()]
  assert.equal(await recall(), null)
  const result = await recall()
  assert.equal(result?.messages.length, 2)
})

test('recall and tools racing in one turn open one session', async () => {
  const { client, recall, tools } = setup('apiClient')
  await Promise.all([recall(), tools(), tools()])
  assert.equal(client.sessions.length, 1)
  assert.deepEqual(client.methods(), [...ADMIN, 'startSession'])
})

test('a turn that failed before completing leaves no session for the next turn', async () => {
  const { client, recall } = setup('apiClient')
  await recall({ turnId: 'turn-1' })
  // No capture: eve completes only a turn that succeeds.
  const next = await recall({ turnId: 'turn-2' })
  assert.equal(client.sessions[0]?.closed, true)
  assert.equal(client.methods().at(-1), 'resumeSession')
  assert.equal(next?.messages.length, 1)
})

test('recall adopts a session tools opened, with no second key and the briefing kept', async () => {
  const { client, tools, recall } = setup('apiClient')
  await tools()
  const result = await recall()
  assert.equal(client.sessions.length, 1)
  assert.equal(client.sessions[0]?.closed, false)
  assert.equal(result?.messages[0]?.id, 'memco-briefing')
})

test('a session recall adopted belongs to that turn, so a later turn closes it', async () => {
  const { client, tools, recall } = setup('apiClient')
  await tools()
  await recall({ turnId: 'turn-1' })
  await recall({ turnId: 'turn-2' })
  assert.equal(client.sessions.length, 2)
  assert.equal(client.sessions[0]?.closed, true)
})

test('a session tools failed to open is forgotten after recall shared the failure', async () => {
  const { client, tools, recall } = setup('token')
  client.failures['startSession'] = [unavailable()]
  const [offered, recalled] = await Promise.all([tools(), recall()])
  assert.equal(offered, null)
  assert.equal(recalled, null)
  const result = await recall()
  assert.equal(result?.messages.length, 2)
})

test('a session older than the key lifetime is closed and dropped by a turn of another eve session', async () => {
  const { client, recall, tools, advance } = setup('apiClient')
  await recall({ eveSession: 'eve-1' })
  advance(11)
  await recall({ eveSession: 'eve-2' })
  assert.equal(client.sessions[0]?.closed, true)
  assert.equal(client.sessions[1]?.closed, false)
  // Dropped: a held entry would be served here, and no session opened.
  await tools({ eveSession: 'eve-1' })
  assert.equal(client.sessions.length, 3)
})

test('a session within the key lifetime stays open across other eve sessions', async () => {
  const { client, recall, advance } = setup('apiClient')
  await recall({ eveSession: 'eve-1' })
  advance(10)
  await recall({ eveSession: 'eve-2' })
  assert.equal(client.sessions[0]?.closed, false)
})

test('a session still in use outlives the key lifetime, as its key renews', async () => {
  const { client, recall, tools, advance } = setup('apiClient')
  await recall({ eveSession: 'eve-1' })
  advance(8)
  await tools({ eveSession: 'eve-1' })
  advance(8)
  await recall({ eveSession: 'eve-2' })
  assert.equal(client.sessions[0]?.closed, false)
  await tools({ eveSession: 'eve-1' })
  assert.equal(client.sessions.length, 2)
})

test('a failure closing an expired session is logged, and the new turn goes on', async () => {
  const { client, logs, recall, advance } = setup('apiClient')
  await recall({ eveSession: 'eve-1' })
  const stale = client.sessions[0]
  assert.ok(stale)
  stale.close = async () => {
    throw new Error('could not end the key')
  }
  advance(11)
  const result = await recall({ eveSession: 'eve-2' })
  assert.equal(result?.messages.length, 1)
  assert.match(logs.join('\n'), /could not end the key/)
})

test('an expired session is reopened for the turn asking, not served', async () => {
  const { client, tools, advance } = setup('apiClient')
  await tools()
  advance(11)
  await tools()
  assert.equal(client.sessions[0]?.closed, true)
  assert.equal(client.sessions.length, 2)
})

test('a failure closing the expired session of the turn asking is logged, and it reopens', async () => {
  const { client, logs, recall, advance } = setup('apiClient')
  await recall({ turnId: 'turn-1' })
  const stale = client.sessions[0]
  assert.ok(stale)
  stale.close = async () => {
    throw new Error('could not end the key')
  }
  advance(11)
  const result = await recall({ turnId: 'turn-2' })
  assert.equal(result?.messages.length, 1)
  assert.equal(client.sessions.length, 2)
  assert.match(logs.join('\n'), /could not end the key/)
})

test('a first turn that cannot open a session provisions once, not twice', async () => {
  const { client, recall } = setup('apiClient')
  client.failures['startSession'] = [denied()]
  await assert.rejects(recall(), { name: 'MemcoPermissionError' })
  assert.deepEqual(client.methods(), [...ADMIN, 'startSession'])
})

test('an outage while provisioning leaves the turn without memory', async () => {
  const { client, recall } = setup('apiClient')
  client.failures['networks.createOrGet'] = [unavailable()]
  assert.equal(await recall(), null)
})

test('tools fail the turn on a refusal that is not an outage', async () => {
  const { client, tools } = setup('token')
  client.failures['startSession'] = [denied()]
  await assert.rejects(tools(), { name: 'MemcoPermissionError' })
})

test('a key lifetime that is not a whole number of minutes is refused up front', () => {
  for (const keyTtlMinutes of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => memco({ keyTtlMinutes }), MemcoConfigError)
  }
  assert.doesNotThrow(() => memco({ keyTtlMinutes: 5 }))
})
