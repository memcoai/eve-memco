import {
  Memco,
  MemcoConfigError,
  MemcoNotFoundError,
  MemcoPermissionError,
  MemcoTimeoutError,
  MemcoUnavailableError,
  briefing,
  type AddMemberOptions,
  type CreateNetworkOptions,
  type CreateUserOptions,
  type MemcoOptions,
  type Session,
  type SessionOptions
} from '@memco/memcoai'
import type { SessionAuth, SessionAuthContext } from 'eve/context'
import { defineState } from 'eve/context'
import {
  defineMemoryProvider,
  type MemoryProvider,
  type MemoryRecallResult,
  type MemoryScope,
  type MemoryToolSet
} from 'eve/memory'
import type { JsonObject } from 'eve/events'
import { defineTool } from 'eve/tools'

import { externalId, networkName } from './derive.js'
import { TENANT_SCOPE } from './scope.js'

/** Names a user for people reading Memco, or `null` for none. */
export type UserNameResolver = (
  principal: SessionAuthContext
) => string | null | undefined | Promise<string | null | undefined>

/** What the provider sets beyond the Memco client's own options. */
export interface MemcoProviderOptions extends MemcoOptions {
  /** The Memco memory domain the slot reads and writes. Defaults to `knowledge`. */
  domain?: string
  /**
   * How many minutes a key acting as a tenant's user lives, in multi-tenant
   * mode. Each turn mints one and ends it when the turn completes, or when the
   * next turn starts after one that failed. A session unused for this long is
   * closed by whichever turn next asks for memory in the process; a session in
   * use outlives it, as its key renews. A process that ends mid-turn leaves its
   * key to expire. Defaults to 10.
   */
  keyTtlMinutes?: number
  /**
   * The readable name of a tenant's user, in multi-tenant mode, set when Memco
   * first creates them; an existing user keeps theirs. It is a label: identity
   * stays the external id, which holds no personal data, so a name may be the
   * first thing here that does. Without one, or when it returns none, a user is
   * named by the external id.
   */
  userName?: UserNameResolver
  /**
   * How many turns apart the nudge is recalled, after the one a session starts
   * with. Each copy stays in context for the rest of the eve session, so a
   * higher number costs fewer tokens and keeps the instruction further from
   * the latest turn. Defaults to 5.
   */
  nudgeEvery?: number
}

/** The part of a Memco session the provider uses. */
export type MemcoSession = Pick<
  Session,
  'id' | 'instructions' | 'domain' | 'close' | 'tools'
>

/** The part of the Memco client the provider uses. */
export interface MemcoClient {
  readonly credentialKind: 'token' | 'apiClient'
  readonly memory: {
    startSession(
      domain: string,
      options?: SessionOptions
    ): Promise<MemcoSession>
    resumeSession(
      sessionId: string,
      options?: SessionOptions
    ): Promise<MemcoSession>
  }
  readonly users: {
    createOrGet(
      externalId: string,
      options: CreateUserOptions
    ): Promise<{ readonly id: string }>
  }
  readonly networks: {
    createOrGet(options: CreateNetworkOptions): Promise<{ readonly id: string }>
    addMember(networkId: string, options: AddMemberOptions): Promise<unknown>
  }
}

/** What eve keeps for one user's Memco session, across turns. JSON only. */
export interface StoredSession {
  /** The Memco session the next turn resumes. */
  readonly sessionId?: string
  /** Whether the user and the tenant network are known to exist. */
  readonly provisioned?: boolean
}

/** Every stored session of one eve session, by {@link Identity.stateKey}. */
export type StoredSessions = Readonly<Record<string, StoredSession>>

/** Where the stored sessions live: eve's `defineState` in production. */
export interface SessionState {
  get(): StoredSessions
  update(fn: (current: StoredSessions) => StoredSessions): void
}

/** What {@link createProvider} is built from. */
export interface ProviderDependencies {
  /** The Memco client, created on first use. */
  client: () => MemcoClient
  state: SessionState
  domain: string
  keyTtlMinutes: number
  nudgeEvery: number
  userName?: UserNameResolver
  /** The current time, in milliseconds. */
  now: () => number
  log: (message: string) => void
}

/** Who a turn's memory belongs to. */
interface Identity {
  /** Keys the stored session and the turn's open session. */
  readonly stateKey: string
  /** The tenant's user, in multi-tenant mode. */
  readonly externalId?: string
  /** The tenant's network, in multi-tenant mode. */
  readonly networkName?: string
  /** The caller, in multi-tenant mode. */
  readonly principal?: SessionAuthContext
}

/** A session opened for a turn, and whether it was started rather than resumed. */
interface Opened {
  readonly session: MemcoSession
  readonly fresh: boolean
}

/** The session a turn opened, and which turn opened it. */
interface Entry {
  /** Unset for a session `tools()` opened, until a recall adopts it. */
  turnId: string | undefined
  readonly opened: Promise<Opened>
  usedAt: number
}

/** The stable id of the briefing, so a later recall replaces it in place. */
export const BRIEFING_ID = 'memco-briefing'

const sessions = defineState<StoredSessions>('memco.sessions', () => ({}))

/**
 * Memco Shared Memory as an eve memory provider.
 *
 * The credential decides the mode. A token is single-user: every caller shares
 * the token's Memco identity. An API client's id and secret are multi-tenant:
 * scope the slot with {@link byTenant}, and each tenant gets its own Memco
 * network, each of its users an external user placed in it.
 *
 * @param options The domain, the key lifetime, and the Memco client's own
 *   options, each falling back to the environment as the client does.
 * @returns The provider, for `defineMemory({ provider })`.
 *
 * @example
 * ```ts
 * export default defineMemory({
 *   description: "The team's shared memory.",
 *   provider: memco(),
 *   scope: byTenant(principal => principal.attributes.tenantId as string)
 * })
 * ```
 */
export function memco(options: MemcoProviderOptions = {}): MemoryProvider {
  const {
    domain = 'knowledge',
    keyTtlMinutes = 10,
    nudgeEvery = 5,
    userName,
    ...clientOptions
  } = options
  // Checked here so a misconfiguration fails when the slot loads, not on
  // every turn.
  if (!Number.isInteger(keyTtlMinutes) || keyTtlMinutes < 1) {
    throw new MemcoConfigError(
      `keyTtlMinutes must be a whole number of minutes from 1 up, got ${keyTtlMinutes}`
    )
  }
  if (!Number.isInteger(nudgeEvery) || nudgeEvery < 1) {
    throw new MemcoConfigError(
      `nudgeEvery must be a whole number of turns from 1 up, got ${nudgeEvery}`
    )
  }
  let client: Memco | undefined
  return defineMemoryProvider(
    createProvider({
      // Created on first use, so the environment is read when the agent runs
      // rather than when the slot's module loads.
      client: () => (client ??= new Memco(clientOptions)),
      state: sessions,
      domain,
      keyTtlMinutes,
      nudgeEvery,
      ...(userName === undefined ? {} : { userName }),
      now: Date.now,
      log: message => console.warn(`[@memco/eve] ${message}`)
    })
  )
}

/**
 * Build the provider from its dependencies.
 *
 * @internal Exported for the tests, which supply a fake client and state.
 */
export function createProvider(dependencies: ProviderDependencies) {
  const { state, domain, keyTtlMinutes, nudgeEvery, now, log } = dependencies

  // The session each turn opened, by eve session and identity, held until the
  // turn completes or its key's lifetime passes. A promise, so a rerun or an
  // overlapping call shares the one open rather than minting a second key.
  const open = new Map<string, Entry>()

  function identify(scope: MemoryScope, auth: SessionAuth): Identity {
    const value = typeof scope.value === 'string' ? [scope.value] : scope.value
    const byTenant = value[0] === TENANT_SCOPE
    // The domain is in every key, so two slots on one agent never share one.
    if (dependencies.client().credentialKind !== 'apiClient') {
      if (byTenant) {
        throw new Error(
          'byTenant memory needs MEMCO_CLIENT_ID and MEMCO_CLIENT_SECRET: with ' +
            'a token, every tenant would share one Memco identity'
        )
      }
      return { stateKey: `${scope.key}:${domain}` }
    }
    const tenant = value[1]
    const principal = auth.current
    if (
      !byTenant ||
      value.length !== 2 ||
      tenant === undefined ||
      principal === null
    ) {
      throw new Error(
        'multi-tenant Memco memory needs a user principal and a scope of one ' +
          'tenant: scope the slot with byTenant'
      )
    }
    const id = externalId(scope.namespace, tenant, principal)
    return {
      stateKey: `${scope.key}:${domain}:${id}`,
      externalId: id,
      networkName: networkName(scope.namespace, tenant, domain),
      principal
    }
  }

  function store(key: string, entry: StoredSession): void {
    state.update(current => ({ ...current, [key]: entry }))
  }

  async function provision(
    identity: Identity,
    namespace: string
  ): Promise<void> {
    const client = dependencies.client()
    const id = identity.externalId as string
    const name = identity.networkName as string
    const given = await dependencies.userName?.(
      identity.principal as SessionAuthContext
    )
    const user = await client.users.createOrGet(id, {
      roles: ['reader', 'creator'],
      name: given?.trim() || id
    })
    const network = await client.networks.createOrGet({
      name,
      domain,
      scope: 'customer',
      owner: name,
      description: `Eve memory · namespace: ${namespace} · domain: ${domain}`
    })
    await client.networks.addMember(network.id, { userId: user.id })
    store(identity.stateKey, {
      ...state.get()[identity.stateKey],
      provisioned: true
    })
  }

  async function startOrResume(
    identity: Identity,
    sessionId: string | undefined
  ): Promise<Opened> {
    const client = dependencies.client()
    const options: SessionOptions =
      identity.externalId === undefined
        ? {}
        : { externalId: identity.externalId, keyTtlMinutes }
    if (sessionId !== undefined) {
      try {
        const session = await client.memory.resumeSession(sessionId, options)
        return { session, fresh: false }
      } catch (error) {
        // The stored session is gone: start another in its place.
        if (!(error instanceof MemcoNotFoundError)) {
          throw error
        }
      }
    }
    const session = await client.memory.startSession(domain, options)
    store(identity.stateKey, {
      ...state.get()[identity.stateKey],
      sessionId: session.id
    })
    return { session, fresh: true }
  }

  async function openFor(
    identity: Identity,
    namespace: string
  ): Promise<Opened> {
    const stored = state.get()[identity.stateKey]
    if (identity.externalId === undefined) {
      return startOrResume(identity, stored?.sessionId)
    }
    const provisioned = stored?.provisioned === true
    if (!provisioned) {
      await provision(identity, namespace)
    }
    try {
      return await startOrResume(identity, stored?.sessionId)
    } catch (error) {
      // Only a stored `provisioned` can be stale; one just made is not.
      if (
        !provisioned ||
        (!(error instanceof MemcoNotFoundError) &&
          !(error instanceof MemcoPermissionError))
      ) {
        throw error
      }
      // The user or the network was deleted: provision again, once.
      store(identity.stateKey, {})
      await provision(identity, namespace)
      return startOrResume(identity, undefined)
    }
  }

  /** Close and forget the session `key` holds, if any. */
  async function release(key: string): Promise<void> {
    const entry = open.get(key)
    if (entry === undefined) return
    open.delete(key)
    // A turn whose open failed has no session to close.
    const turn = await entry.opened.catch(() => null)
    await turn?.session.close()
  }

  /**
   * Close and forget every session unused for its key's lifetime, in any eve
   * session: a failed turn's is otherwise held until its eve session has
   * another turn. A turn asks for its session before every model call, so this
   * spares a running turn, unless one step outlasts the lifetime. A failure to
   * close is logged, as the turn asking has no part in it.
   */
  async function evict(): Promise<void> {
    const oldest = now() - keyTtlMinutes * 60_000
    const stale = [...open].filter(([, entry]) => entry.usedAt < oldest)
    await Promise.all(
      stale.map(([key]) =>
        release(key).catch(error => {
          log(`could not close an expired session: ${error}`)
        })
      )
    )
  }

  /**
   * The session for `identity` in this eve session: the one already open, or a
   * new one.
   *
   * @param turnId The turn asking, when known. A session another turn opened
   *   is closed first: eve completes only a turn that succeeds, so a failed
   *   turn's session is still held, and no session serves two turns. One opened
   *   with no turn id, by `tools()`, is adopted: eve can ask for tools before
   *   recall, and the session and its `fresh` are this turn's.
   */
  async function opened(
    eveSession: string,
    identity: Identity,
    namespace: string,
    turnId?: string
  ): Promise<Opened> {
    await evict()
    const key = `${eveSession}\0${identity.stateKey}`
    const held = open.get(key)
    if (held !== undefined && turnId !== undefined) {
      if (held.turnId === undefined) {
        held.turnId = turnId
      } else if (held.turnId !== turnId) {
        await release(key)
      }
    }
    let entry = open.get(key)
    if (entry === undefined) {
      const created: Entry = {
        turnId,
        opened: openFor(identity, namespace),
        usedAt: now()
      }
      entry = created
      open.set(key, created)
      // A failed open is forgotten, so the next call tries again.
      created.opened.catch(() => {
        if (open.get(key) === created) open.delete(key)
      })
    }
    entry.usedAt = now()
    return entry.opened
  }

  /** Whether a failure is an outage, which leaves the turn without memory. */
  function outage(error: unknown, during: string): boolean {
    if (
      error instanceof MemcoUnavailableError ||
      error instanceof MemcoTimeoutError
    ) {
      log(`${during} without memory: ${error.message}`)
      return true
    }
    return false
  }

  return {
    recall: {
      'turn.started': async (context): Promise<MemoryRecallResult> => {
        const { scope, slot } = context.memory
        const prefix = `${slot}__`
        try {
          const identity = identify(scope, context.session.auth)
          const { session, fresh } = await opened(
            context.session.id,
            identity,
            scope.namespace,
            context.turn.id
          )
          const messages = []
          if (fresh) {
            if (session.domain === null) {
              log(`no briefing: the listing does not describe '${domain}'`)
            } else {
              messages.push({
                id: BRIEFING_ID,
                content: briefing(session.domain, session.instructions, prefix)
              })
            }
          }
          if (fresh || context.turn.sequence % nudgeEvery === 0) {
            messages.push({ content: nudge(prefix) })
          }
          return { messages }
        } catch (error) {
          if (outage(error, 'recall')) return null
          throw error
        }
      }
    },

    tools: async (context): Promise<MemoryToolSet | null> => {
      const { scope, slot } = context.memory
      const prefix = `${slot}__`
      try {
        const identity = identify(scope, context.session.auth)
        const { session } = await opened(
          context.session.id,
          identity,
          scope.namespace
        )
        const offered = session.tools({ prefix }).tools
        return Object.fromEntries(
          offered.map(tool => [
            tool.name.slice(prefix.length),
            defineTool({
              description: tool.description,
              // Plain JSON Schema, which the SDK's narrower type does not prove.
              inputSchema: tool.parameters as unknown as JsonObject,
              execute: input => tool.call(input)
            })
          ])
        )
      } catch (error) {
        if (outage(error, 'tools')) return null
        throw error
      }
    },

    capture: {
      'turn.completed': async (context): Promise<void> => {
        const identity = identify(context.memory.scope, context.session.auth)
        await release(`${context.session.id}\0${identity.stateKey}`)
      }
    }
  } satisfies MemoryProvider
}

/**
 * The instruction recalled when a session starts and every `nudgeEvery` turns.
 *
 * @param prefix What the slot's tools start with.
 */
function nudge(prefix: string): string {
  return (
    `Before working on this, search the team's shared memory with ` +
    `${prefix}search for what is already known. When you learn a lesson the ` +
    `team will need again, not general knowledge, save it with ` +
    `${prefix}create_memory or ${prefix}enrich_memory before you finish.`
  )
}
