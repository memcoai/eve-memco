/**
 * A fake Memco client at the SDK boundary: it records every call the provider
 * makes and hands out sessions that need no service.
 */

import {
  MemcoNotFoundError,
  MemcoPermissionError,
  MemcoTimeoutError,
  MemcoUnavailableError,
  MemcoUnhealthyError,
  Toolset,
  type DomainEntry,
  type Instructions,
  type SessionOptions,
  type Tool,
  type ToolsOptions
} from '@memco/memcoai'

import type { MemcoClient, MemcoSession } from '../src/provider.js'

export const DOMAIN: DomainEntry = {
  slug: 'knowledge',
  title: 'Knowledge',
  summary: 'What the team knows.',
  whenToSearch: 'Before working anything out.',
  whenToSave: 'After learning something.',
  whatNotToSave: 'Secrets.',
  tagsDescription: 'Tag by topic.',
  filterTagTypes: [],
  versionTagTypes: [],
  maxTagsPerQuery: 10
} as unknown as DomainEntry

const INSTRUCTIONS: Instructions = {
  content: 'Search with memco_search.',
  policy: '',
  adding: '',
  rating: '',
  next: ''
} as unknown as Instructions

/** One call the fake received, by method and arguments. */
export interface Call {
  method: string
  args: unknown[]
}

export class FakeSession implements MemcoSession {
  closed = false
  readonly instructions = INSTRUCTIONS

  constructor(
    readonly id: string,
    readonly domain: DomainEntry | null,
    readonly externalId: string | undefined
  ) {}

  tools(options: ToolsOptions = {}): Toolset {
    const prefix = options.prefix ?? 'memco_'
    const tool = (op: string): Tool => ({
      name: `${prefix}${op}`,
      description: `${op}, see ${prefix}search`,
      parameters: { type: 'object', properties: {}, required: [] },
      call: async args =>
        `${op} ran as ${this.externalId ?? 'token'}: ${JSON.stringify(args)}`
    })
    return new Toolset([tool('search'), tool('create_memory')])
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/** What a method throws, once per staged entry, before answering normally. */
type Failures = Partial<Record<string, Error[]>>

export class FakeMemco implements MemcoClient {
  readonly calls: Call[] = []
  readonly sessions: FakeSession[] = []
  readonly failures: Failures = {}
  /** Session ids the service knows, so a resume of any other is refused. */
  readonly known = new Set<string>()
  domain: DomainEntry | null = DOMAIN

  constructor(readonly credentialKind: 'token' | 'apiClient') {}

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
    const failure = this.failures[method]?.shift()
    if (failure !== undefined) {
      throw failure
    }
  }

  /** The methods called so far, in order. */
  methods(): string[] {
    return this.calls.map(call => call.method)
  }

  readonly memory = {
    startSession: async (
      domain: string,
      options: SessionOptions = {}
    ): Promise<FakeSession> => {
      this.record('startSession', domain, options)
      const session = new FakeSession(
        `session-${this.sessions.length + 1}`,
        this.domain,
        options.externalId
      )
      this.sessions.push(session)
      this.known.add(session.id)
      return session
    },
    resumeSession: async (
      sessionId: string,
      options: SessionOptions = {}
    ): Promise<FakeSession> => {
      this.record('resumeSession', sessionId, options)
      if (!this.known.has(sessionId)) {
        throw notFound(`session ${sessionId}`)
      }
      const session = new FakeSession(
        sessionId,
        this.domain,
        options.externalId
      )
      this.sessions.push(session)
      return session
    }
  }

  readonly users = {
    createOrGet: async (externalId: string, options: unknown) => {
      this.record('users.createOrGet', externalId, options)
      return { id: `user-${externalId}` }
    }
  }

  readonly networks = {
    createOrGet: async (options: { name: string }) => {
      this.record('networks.createOrGet', options)
      return { id: `network-${options.name}` }
    },
    // Adding a user already in the network is a no-op, as the service has it.
    addMember: async (networkId: string, options: unknown) => {
      this.record('networks.addMember', networkId, options)
      return {}
    }
  }
}

// gRPC status codes, as the SDK's errors carry them.
export const notFound = (what: string) =>
  new MemcoNotFoundError(5, `${what} not found`)
export const denied = () => new MemcoPermissionError(7, 'permission denied')
export const unavailable = () => new MemcoUnavailableError(14, 'try again')
export const unhealthy = () => new MemcoUnhealthyError(14, 'not serving')
export const timedOut = () => new MemcoTimeoutError(4, 'deadline exceeded')
