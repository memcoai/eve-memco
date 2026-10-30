// Proves @memco/eve end to end against a live Memco test org and a real model:
//
//   node --enable-source-maps build/examples/validate.js <single|multi>
//
// Each fact carries a random nonce, so a reply can only hold it through memory,
// and no prompt asks the model to save: that is the provider's nudge at work.
import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify, parseEnv } from 'node:util'

import { DEFAULT_HOST, Memco, type MemcoOptions } from '@memco/memcoai'
import { Client, type ClientSession } from 'eve/client'

import { externalId, networkName } from '../src/derive.js'

type Mode = 'single' | 'multi'

/** One line of the example's audit instrumentation. */
interface AuditLine {
  type: string
  phase?: string
  slot?: string
  operationName?: string
  outcome?: string
  sessionId: string
}

/** A settled turn. */
interface Turn {
  session: ClientSession
  reply: string
  /** The name of each call the model made, in order. */
  calls: string[]
  /** The calls that did not settle `completed`, as `name: outcome`. */
  failedCalls: string[]
  /** Each rating the model gave, as sent to `memco__share_feedback`. */
  ratings: Rating[]
}

/** One rating of a search result. */
interface Rating {
  idx: string
  relevant: boolean
  correct?: boolean
}

/** What a mode runs with. */
interface Setup {
  /** The example's directory. */
  dir: string
  /** The eve CLI the example installed. */
  eve: string
  /** The server's whole environment. */
  env: NodeJS.ProcessEnv
  /** The driver's own Memco credential: the server's, passed explicitly. */
  memco: MemcoOptions
  /** Where both will write. */
  host: string
}

const DOMAIN = 'knowledge'
const NAMESPACE = 'acme-support-agent'
const PORT = 2000
const BASE_URL = `http://127.0.0.1:${PORT}`

const TURN_MS = seconds('VALIDATE_TURN_SECONDS', 180)
const INGEST_MS = seconds('VALIDATE_INGEST_SECONDS', 120)
const BOOT_MS = 120_000
const SHUTDOWN_MS = 5_000

// What `eve dev` reads into the server's environment. A file fills in what the
// shell left unset, so one could bring back a credential removed below.
const ENV_FILES = [
  '.env.development.local',
  '.env.local',
  '.env.development',
  '.env'
]

const CREDENTIALS = {
  single: {
    dir: 'examples/single-user',
    required: ['MEMCO_API_TOKEN'],
    removed: ['MEMCO_CLIENT_ID', 'MEMCO_CLIENT_SECRET', 'MEMCO_API_KEY']
  },
  multi: {
    dir: 'examples/multi-tenant',
    required: ['MEMCO_CLIENT_ID', 'MEMCO_CLIENT_SECRET'],
    removed: ['MEMCO_API_TOKEN', 'MEMCO_API_KEY']
  }
} as const

function seconds(name: string, fallback: number): number {
  return Number(process.env[name] ?? fallback) * 1000
}

/** The memco variables an env file sets, as `file: NAME`. */
function fileCredentials(dir: string): string[] {
  return ENV_FILES.map(file => join(dir, file))
    .filter(existsSync)
    .flatMap(file =>
      Object.keys(parseEnv(readFileSync(file, 'utf8')))
        .filter(name => name.startsWith('MEMCO_'))
        .map(name => `${file}: ${name}`)
    )
}

/**
 * Check a mode can run, and build its environment.
 *
 * @throws Error Naming what is missing, before anything starts or is written.
 */
function prepare(mode: Mode): Setup {
  const { dir, required, removed } = CREDENTIALS[mode]
  const missing = [...required, 'ANTHROPIC_API_KEY'].filter(
    name => !process.env[name]?.trim()
  )
  if (missing.length > 0) {
    throw new Error(`${mode} needs ${missing.join(', ')} in the environment`)
  }
  const inFiles = [...fileCredentials(dir), ...fileCredentials('.')]
  if (inFiles.length > 0) {
    throw new Error(
      `env files would change the server's credentials: ${inFiles.join(', ')}`
    )
  }
  const eve = resolve('node_modules/.bin/eve')
  if (!existsSync(eve)) {
    throw new Error(`${eve} is missing: run \`make examples\``)
  }

  const env: NodeJS.ProcessEnv = { ...process.env, EVE_TELEMETRY_DISABLED: '1' }
  for (const name of removed) delete env[name]
  delete env['EXAMPLE_TEST_AUTH']
  if (mode === 'multi') {
    env['EXAMPLE_TEST_AUTH'] = '1'
    env['MEMCO_LOG'] = 'debug'
  }

  return {
    dir,
    eve,
    env,
    memco:
      mode === 'single'
        ? { token: env['MEMCO_API_TOKEN'] as string }
        : {
            clientId: env['MEMCO_CLIENT_ID'] as string,
            clientSecret: env['MEMCO_CLIENT_SECRET'] as string
          },
    host: env['MEMCO_API_HOST']?.trim() || DEFAULT_HOST
  }
}

/** Run `check` until it holds or `timeoutMs` passes; whether it held. */
async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 1000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() + stepMs > deadline) return false
    await sleep(stepMs)
  }
}

function elapsed(since: number): number {
  return Math.round((performance.now() - since) / 100) / 10
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE_URL}/eve/v1/health`)).ok
  } catch {
    return false
  }
}

/** What `eve info --json` prints; run it before the server starts. */
async function eveInfo({ dir, eve, env }: Setup) {
  const { stdout } = await promisify(execFile)(eve, ['info', '--json'], {
    cwd: dir,
    env
  })
  return JSON.parse(stdout) as { status: string }
}

interface Server {
  /** Every audit line so far, in order. */
  audit: AuditLine[]
  /** How many impersonation keys the server has minted and ended so far. */
  keys: { minted: number; ended: number }
  stop(): Promise<void>
}

/**
 * Start the example's server and wait until it is healthy.
 *
 * @throws Error If something already answers on the port, which would be
 *   running with some other environment, or if the server does not come up.
 */
async function startServer({ dir, eve, env }: Setup): Promise<Server> {
  if (await healthy()) {
    throw new Error(`a server already answers at ${BASE_URL}: stop it first`)
  }
  const args = ['dev', '--no-ui', '--no-default-extensions']
  const child = spawn(eve, [...args, '--port', String(PORT)], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const audit: AuditLine[] = []
  const keys = { minted: 0, ended: 0 }
  const log: string[] = []
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', line => {
      log.push(line)
      if (log.length > 40) log.shift()
      const json = /\[audit\] (\{.*\})\s*$/.exec(line)?.[1]
      if (json !== undefined) audit.push(JSON.parse(json) as AuditLine)
      // The SDK's debug log is the only view of them: the service's key listing
      // leaves out impersonation keys.
      if (/DEBUG ImpersonateExternalUser ok/.test(line)) keys.minted += 1
      if (/DEBUG EndImpersonation ok/.test(line)) keys.ended += 1
    })
  }

  // `eve dev` forks the server detached, so it has to go through the CLI's own
  // shutdown: a SIGKILL here orphans the server, which is checked for below.
  let stopped: Promise<void> | undefined
  const stop = () => (stopped ??= shutdown())
  async function shutdown(): Promise<void> {
    process.off('exit', onExit)
    const exited = new Promise(done => child.once('exit', done))
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([exited, sleep(SHUTDOWN_MS)])
    if (child.exitCode === null) child.kill('SIGKILL')
    if (!(await until(async () => !(await healthy()), SHUTDOWN_MS, 250))) {
      console.error(`WARNING: a server still answers at ${BASE_URL}`)
    }
  }
  const onExit = () => child.kill('SIGTERM')
  process.once('exit', onExit)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().finally(() => process.exit(130))
    })
  }

  const up = await until(
    async () => child.exitCode !== null || (await healthy()),
    BOOT_MS
  )
  if (!up || child.exitCode !== null) {
    await stop()
    throw new Error(`the server did not start:\n${log.join('\n')}`)
  }
  return { audit, keys, stop }
}

/** A client of the server, as the headers' user or, without them, anonymous. */
function eveClient(headers?: Record<string, string>): Client {
  return new Client({
    baseUrl: BASE_URL,
    ...(headers === undefined ? {} : { headers })
  })
}

type Delivery = Awaited<ReturnType<ClientSession['send']>>

/** Follow a turn until it settles, or cancel it at the turn timeout. */
async function settle(
  session: ClientSession,
  delivery: Delivery
): Promise<Turn> {
  const signal = AbortSignal.timeout(TURN_MS)
  const names = new Map<string, string>()
  const failedCalls: string[] = []
  const ratings: Rating[] = []
  try {
    for await (const event of delivery.stream({ signal })) {
      if (event.type === 'call.requested') {
        names.set(event.data.callId, event.data.capability.name)
        if (event.data.capability.name === 'memco__share_feedback') {
          const input = event.data.input as { feedback?: Rating[] }
          ratings.push(...(input.feedback ?? []))
        }
      }
      if (event.type === 'call.settled' && event.data.outcome !== 'completed') {
        const name = names.get(event.data.callId) ?? event.data.callId
        failedCalls.push(`${name}: ${event.data.outcome}`)
      }
    }
    const result = await delivery.result({ signal })
    if (result.status !== 'completed') {
      const why = result.status === 'failed' ? `: ${result.error.message}` : ''
      throw new Error(`turn ${result.status}${why}`)
    }
    return {
      session,
      reply: result.reply ?? '',
      calls: [...names.values()],
      failedCalls,
      ratings
    }
  } catch (error) {
    if (!signal.aborted) throw error
    await session.cancel().catch(() => undefined)
    throw new Error(`turn still running after ${TURN_MS / 1000}s`)
  }
}

/** Start a new session with `message`, and wait for its turn. */
async function firstTurn(client: Client, message: string) {
  const { session, delivery } = await client.sessions.create({ message })
  return settle(session, delivery)
}

/** Send `message` in `session`, and wait for its turn. */
async function nextTurn(session: ClientSession, message: string) {
  return settle(session, await session.send(message))
}

/**
 * Start a session and cancel its first turn once the model is at work: by then
 * the turn has opened its Memco session.
 *
 * @returns The session, and the status the turn settled with.
 */
async function cancelledTurn(client: Client, message: string) {
  const { session, delivery } = await client.sessions.create({ message })
  const signal = AbortSignal.timeout(TURN_MS)
  for await (const event of delivery.stream({ signal })) {
    if (event.type === 'call.requested' || event.type === 'content.delta') {
      await (await session.cancel({ signal })).result({ signal })
      break
    }
  }
  const { status } = await delivery.result({ signal })
  return { session, status }
}

/** Whether `session`'s durable stream records its end. */
async function streamEnded(session: ClientSession): Promise<boolean> {
  for await (const event of session.stream({ startIndex: 0, follow: false })) {
    if (event.type === 'session.ended') return true
  }
  return false
}

/** The slots the running server reports. */
async function memorySlots(client: Client): Promise<string[]> {
  const { memories } = await client.info()
  return memories.map(memory => memory.slot)
}

/** Whether `text` holds `nonce`, however the model cased it. */
function holds(text: string, nonce: string): boolean {
  return text.toLowerCase().includes(nonce.toLowerCase())
}

/**
 * What one search finds, as a user or under the client's own credential.
 *
 * Each search gets a session of its own: a memory its session already returned
 * comes back as a reference, without its insights. Closing it ends the key it
 * minted, which would otherwise count as the provider's in `liveKeys`.
 */
async function search(
  memco: Memco,
  query: string,
  externalId?: string
): Promise<string> {
  const session = await memco.memory.startSession(
    DOMAIN,
    externalId === undefined ? {} : { externalId }
  )
  try {
    const { memories } = await session.search(query)
    return memories
      .flatMap(memory => memory.insights)
      .map(insight => `${insight.title}\n${insight.content}`)
      .join('\n')
  } finally {
    await session.close()
  }
}

/** Wait for ingestion to make `nonce` findable, and how long it took. */
async function awaitMemory(
  memco: Memco,
  query: string,
  nonce: string,
  externalId?: string
): Promise<{ found: boolean; seconds: number }> {
  const since = performance.now()
  const found = await until(
    async () => holds(await search(memco, query, externalId), nonce),
    INGEST_MS,
    5000
  )
  return { found, seconds: elapsed(since) }
}

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'REPORT'
type Values = Record<string, unknown>

interface Result {
  id: string
  status: Status
  failures: string[]
  values: Values
}

/** How long a server's audit lines get to arrive. */
const AUDIT_MS = 15_000
/** How long to watch for an audit line that should never come. */
const QUIET_MS = 5_000
/** How long an ended key gets to leave the listing. */
const KEY_MS = 30_000

const SAVE = new Set(['memco__create_memory', 'memco__enrich_memory'])

const nonce = randomBytes(5).toString('hex')
// Shared with the query, so it finds this run's fact and no earlier run's, but
// separate from the nonce, so asking never gives the answer away.
const topic = `RX-${randomBytes(3).toString('hex')}`

// A different subject each run: near-identical facts pile up in a shared
// organization, and an endorsed one then outranks the fact this run just saved.
const SYSTEMS = [
  'webhook deliveries',
  'invoice exports',
  'search indexing',
  'audit log shipping',
  'report generation',
  'email digests'
]
const EVENTS = [
  'a broker failover',
  'a certificate rotation',
  'a database failover',
  'a region evacuation',
  'a cache flush',
  'a schema migration'
]
const system = SYSTEMS[randomInt(SYSTEMS.length)] as string
const event = EVENTS[randomInt(EVENTS.length)] as string

const TEACH =
  `We just closed out ticket class ${topic} after two days of digging: ` +
  `${system} kept stalling after ${event}, and nothing in the docs covers it. ` +
  `What finally fixed it was setting FLUX_RETRY_${nonce}=7 on the dispatcher. ` +
  `Can you give me a one-line summary for the ticket?`
const ASK =
  `A customer just opened a ticket of class ${topic}: their ${system} stalled ` +
  `after ${event}. What is the exact setting that fixes it?`
const QUERY = `fix for ticket class ${topic}, ${system} stalled after ${event}`

function user(name: string, tenant: string) {
  const id = `${name}@${tenant}`
  return {
    externalId: externalId(NAMESPACE, tenant, {
      authenticator: 'dev-headers',
      principalId: id,
      principalType: 'user',
      attributes: { tenantId: tenant }
    }),
    name: id,
    client: eveClient({ 'x-test-user': id, 'x-test-tenant': tenant })
  }
}

// This run's own tenants, so it starts empty, provisions them from nothing, and
// cannot be confused by what earlier runs left. They are removed at the end.
const acme = `acme-${nonce}`
const globex = `globex-${nonce}`
const alice = user('alice', acme)
const bob = user('bob', acme)
const carol = user('carol', globex)
const anonymous = eveClient()
const acmeNetwork = networkName(NAMESPACE, acme, DOMAIN)
const globexNetwork = networkName(NAMESPACE, globex, DOMAIN)

const results: Result[] = []

/** Records what one scenario observed. */
class Scenario {
  readonly failures: string[] = []
  readonly values: Values = {}

  check(ok: boolean, failure: string): void {
    if (!ok) this.failures.push(failure)
  }

  note(values: Values): void {
    Object.assign(this.values, values)
  }
}

function brief(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const line = text.replace(/\s+/g, ' ')
  return line.length > 100 ? `${line.slice(0, 100)}...` : line
}

/**
 * Run one scenario; a failure or a throw never stops the next.
 *
 * @param needs The scenarios that must have passed for this one to mean
 *   anything; otherwise it is skipped.
 * @param reportOnly Whether it reports what it saw, and never fails.
 */
async function scenario(
  id: string,
  body: (s: Scenario) => Promise<void>,
  { needs = [] as string[], reportOnly = false } = {}
): Promise<void> {
  const s = new Scenario()
  const unmet = needs.filter(
    need => results.find(result => result.id === need)?.status !== 'PASS'
  )
  let status: Status = 'SKIP'
  if (unmet.length > 0) {
    s.note({ needs: unmet })
  } else {
    await body(s).catch((error: unknown) => {
      s.failures.push(error instanceof Error ? error.message : String(error))
    })
    status = s.failures.length > 0 ? 'FAIL' : 'PASS'
    if (reportOnly) status = 'REPORT'
  }
  results.push({ id, status, failures: s.failures, values: s.values })
  const values = Object.entries(s.values).map(([k, v]) => `${k}=${brief(v)}`)
  const failures = s.failures.map(failure => `! ${failure}`)
  console.log(
    [status.padEnd(6), id.padEnd(3), ...values, ...failures].join(' ')
  )
}

/** W1: the slot is mounted, and a turn recalls and captures through it. */
function wiring(server: Server, client: Client, compiled: string) {
  return scenario('W1', async s => {
    const slots = await memorySlots(client)
    s.note({ compiled, slots })
    s.check(compiled === 'ready', `eve info: ${compiled}`)
    s.check(slots.includes('memco'), 'no memco slot in /eve/v1/info')

    const { session, reply } = await firstTurn(
      client,
      'In one sentence, what is the difference between a 502 and a 504?'
    )
    s.note({ reply })
    const settled = (phase: string, operationName: string) =>
      server.audit.some(
        line =>
          line.type === 'memory.operation.settled' &&
          line.sessionId === session.id &&
          line.slot === 'memco' &&
          line.phase === phase &&
          line.operationName === operationName &&
          line.outcome === 'completed'
      )
    const recalled = () => settled('turn.started', 'search_memory')
    const captured = () => settled('turn.completed', 'upsert_memory')
    await until(() => recalled() && captured(), AUDIT_MS)
    s.note({ auditLines: server.audit.length, sessionId: session.id })
    s.check(recalled(), 'no completed recall in the audit')
    s.check(captured(), 'no completed capture in the audit')
  })
}

/** S1, M1: the model saves what it is taught, unasked. */
async function teach(s: Scenario, memco: Memco, client: Client, as?: string) {
  const { calls, failedCalls } = await firstTurn(client, TEACH)
  s.note({ calls, failedCalls })
  // Enriching counts: a fact from an earlier run is a fair place for this one.
  const saved = calls.some(call => SAVE.has(call))
  s.check(saved, 'the model did not save')
  if (!saved) return
  const { found, seconds } = await awaitMemory(memco, QUERY, nonce, as)
  s.note({ ingestSeconds: seconds })
  s.check(found, `the memory did not land within ${seconds}s`)
}

/** S1, S2: one token, one memory across sessions. */
async function singleUser(memco: Memco, client: Client) {
  await scenario('S1', s => teach(s, memco, client))
  await scenario(
    'S2',
    async s => {
      const { calls, reply } = await firstTurn(client, ASK)
      s.note({ calls, reply })
      s.check(calls.includes('memco__search'), 'memco__search not called')
      s.check(holds(reply, nonce), 'the reply lacks the nonce')
    },
    { needs: ['S1'] }
  )
}

/** M1-M4, K1, K2: tenants share within and never across, and keys end. */
async function multiTenant(server: Server, memco: Memco) {
  await scenario('M1', async s => {
    await teach(s, memco, alice.client, alice.externalId)
    const { networks } = await memco.networks.list({ name: acmeNetwork })
    s.note({ networks: networks.length })
    s.check(networks.length === 1, `${networks.length} networks, not 1`)
    const network = networks[0]
    if (network === undefined) return
    const { id, name } = await memco.users.get(alice.externalId)
    const { members } = await memco.networks.listMembers(network.id)
    s.note({ members: members.length })
    s.check(
      members.some(member => member.userId === id),
      'alice is not in the network'
    )
    s.note({ name })
    s.check(name === alice.name, `alice is named ${name}`)
  })

  await scenario('K1', async s => {
    const minted = server.keys.minted
    await firstTurn(alice.client, 'What does HTTP 429 mean, in five words?')
    const since = performance.now()
    await until(() => held(server) === 0, KEY_MS)
    s.note({
      minted: server.keys.minted - minted,
      held: held(server),
      seconds: elapsed(since)
    })
    s.check(server.keys.minted > minted, 'no key minted: the log shows none')
    s.check(held(server) === 0, 'a key outlived the completed turn')
  })

  await scenario(
    'M2',
    async s => {
      const { calls, reply } = await firstTurn(bob.client, ASK)
      s.note({ calls, reply })
      s.check(holds(reply, nonce), 'the reply lacks the nonce')
    },
    { needs: ['M1'] }
  )

  await scenario(
    'M3',
    async s => {
      const { calls, reply } = await firstTurn(carol.client, ASK)
      s.note({ calls, reply })
      s.check(!holds(reply, nonce), 'the nonce crossed tenants in a reply')
      const found = await search(memco, QUERY, carol.externalId)
      s.check(!holds(found, nonce), 'the nonce crossed tenants in a search')
    },
    { needs: ['M1'] }
  )

  await scenario('M4', async s => {
    const { session, calls, reply } = await firstTurn(anonymous, ASK)
    await sleep(QUIET_MS)
    const operations = operationsOf(server.audit, session.id)
    s.note({ calls, reply, memoryOperations: operations.length })
    s.check(
      !calls.some(call => call.startsWith('memco__')),
      'an anonymous turn called memory tools'
    )
    s.check(operations.length === 0, 'an anonymous turn reached the provider')
  })

  await scenario('K2', async s => {
    const { session, status } = await cancelledTurn(
      alice.client,
      'Customers on the EU cluster report intermittent 502s during deploys. ' +
        'Write me a detailed runbook for diagnosing them.'
    )
    await sleep(QUIET_MS)
    const afterCancel = held(server)
    s.note({ status, afterCancel })
    s.check(status === 'cancelled', `the turn settled ${status}`)
    s.check(afterCancel === 1, 'expected the cancelled turn to hold its key')

    await nextTurn(session, 'Never mind, it stopped on its own. Thanks!')
    await until(() => held(server) === 0, KEY_MS)
    s.note({ afterNext: held(server) })
    s.check(held(server) === 0, 'a key outlived the next turn')
  })
}

/** The keys minted and not ended, as the server's log tells it. */
function held(server: Server): number {
  return server.keys.minted - server.keys.ended
}

function operationsOf(lines: AuditLine[], sessionId: string) {
  return lines.filter(
    line =>
      line.sessionId === sessionId && line.type.startsWith('memory.operation')
  )
}

/** E1: ending a session stops its memory. */
function ending(server: Server, client: Client) {
  return scenario('E1', async s => {
    const { session } = await firstTurn(client, 'Hi, are you there?')
    // An idle session ends at once, closing the stream before the end's own
    // delivery settles, so there is no result to wait for.
    await session.end({ reason: 'validate E1' })

    const ended = () =>
      server.audit.findIndex(
        line => line.type === 'session.ended' && line.sessionId === session.id
      )
    await until(() => ended() !== -1, AUDIT_MS)
    await sleep(QUIET_MS)
    const inAudit = ended() !== -1
    const after = inAudit
      ? operationsOf(server.audit.slice(ended() + 1), session.id)
      : []
    const inStream = await streamEnded(session)
    s.note({ inStream, inAudit, operationsAfter: after.length })
    s.check(inStream, 'no session.ended in the stream')
    s.check(inAudit, 'no session.ended in the audit')
    s.check(after.length === 0, 'memory operations after the session ended')
  })
}

const SHOULD_SAVE = [
  (id: string) =>
    `Just closed a billing escalation: invoices doubled for customers who ` +
    `changed plan mid-cycle, because the proration job runs twice unless ` +
    `LEDGER_LOCK_${id} is held. Holding the lock fixed it. Can you draft a ` +
    `one-line note to the customer?`,
  (id: string) =>
    `Finally solved the SSO logins that kept failing for one customer: their ` +
    `identity provider's clock runs 80 seconds fast, and raising ` +
    `saml_skew_${id} to 90 sorted it. What should I put in the ticket's ` +
    `resolution field?`,
  (id: string) =>
    `Found why migration job mig-${id} hung every release: pgbouncer in ` +
    `transaction mode silently breaks its advisory locks, so it now connects ` +
    `to Postgres directly and it's fine. Could you phrase that for the ` +
    `release notes in one line?`,
  (id: string) =>
    `Push alerts were disappearing on Android 15 until we moved them to ` +
    `notification channel alerts_${id}: the old channel gets silenced after ` +
    `an app update. That fixed it. Please write a one-line changelog entry.`,
  (id: string) =>
    `The CSV import was rejecting files saved from Excel. It was the byte ` +
    `order mark on the first column, and turning on the importer flag ` +
    `strip_bom_${id} fixed it for everyone. Can you tell the customer in one ` +
    `friendly sentence?`
]

const SHOULD_NOT_SAVE = [
  'Morning! How is your day going?',
  'What is 17 times 6?',
  'Rephrase this more politely: "send me the logs now".'
]

/** R1: how often the model saves when it should, and when it should not. */
function reflection(client: Client) {
  return scenario(
    'R1',
    async s => {
      const saved = async (prompts: string[]) => {
        const turns = await Promise.all(
          prompts.map(prompt =>
            firstTurn(client, prompt).catch((error: unknown) => {
              s.failures.push((error as Error).message)
              return null
            })
          )
        )
        const count = turns.filter(turn =>
          turn?.calls.some(call => SAVE.has(call))
        ).length
        return `${count}/${prompts.length}`
      }
      const fresh = () => randomBytes(4).toString('hex')
      const [shouldSave, shouldNotSave] = await Promise.all([
        saved(SHOULD_SAVE.map(prompt => prompt(fresh()))),
        saved(SHOULD_NOT_SAVE)
      ])
      s.note({ 'should-save': shouldSave, 'should-not-save': shouldNotSave })
    },
    { reportOnly: true }
  )
}

const CONVERSATIONS = [
  (id: string) => [
    'Customers on the EU cluster get 504s on report exports since Tuesday. ' +
      'Where should I look?',
    'The gateway logs show the export worker dying after exactly 30 seconds.',
    `Found it: EXPORT_DEADLINE_${id} was capped at 30 in the worker config, ` +
      'so I raised it to 300.',
    'Exports are working again, thanks!'
  ],
  (id: string) => [
    'Some users stop getting password reset emails after a few requests. ' +
      'Any idea why?',
    'Our mail provider says nothing was rejected, and it never received them.',
    `It was our own limiter: MAIL_BURST_${id} counts per domain, not per ` +
      'user, so one big customer starved the rest. Keyed it by user instead.',
    'Confirmed with the customer, all good now. Thanks for the help.'
  ],
  (id: string) => [
    'The nightly sync has started skipping about 3% of accounts. How would ' +
      'you narrow that down?',
    'The skipped accounts all have a plus sign in their email address.',
    `The cursor was URL-decoding them, turning + into a space. Encoding the ` +
      `cursor with CURSOR_ENC_${id} fixed it.`,
    'Last night ran clean. Cheers!'
  ]
]

/**
 * R2: the reflection a real session needs. The finding emerges across turns
 * and the session closes on a short thank-you, with no finished fact handed
 * over at its start, as R1 does.
 */
function sessionReflection(client: Client) {
  return scenario(
    'R2',
    async s => {
      const savedAt = await Promise.all(
        CONVERSATIONS.map(async conversation => {
          const [opening, ...rest] = conversation(
            randomBytes(4).toString('hex')
          ) as [string, ...string[]]
          const first = await firstTurn(client, opening)
          const turns = [first]
          for (const message of rest) {
            turns.push(await nextTurn(first.session, message))
          }
          const at = turns.findIndex(turn =>
            turn.calls.some(call => SAVE.has(call))
          )
          return at === -1 ? null : at + 1
        })
      )
      s.note({
        saved: `${savedAt.filter(at => at !== null).length}/${savedAt.length}`,
        'saved-at-turn': savedAt
      })
    },
    { reportOnly: true }
  )
}

/**
 * F1: whether a rating carries a verdict. An insight shows positive or
 * negative feedback only for a rating that is relevant with `correct` set, and
 * the model can only set it once it knows whether the memory worked.
 */
function verdicts(client: Client) {
  return scenario(
    'F1',
    async s => {
      const rated = async (outcome: string) => {
        const first = await firstTurn(client, ASK)
        const after = await nextTurn(first.session, outcome)
        // Apart, as the service keeps a search's first rating of an insight.
        return { before: first.ratings, after: after.ratings }
      }
      const [worked, failed] = await Promise.all([
        rated(
          'I applied exactly that fix and the deliveries resumed. It worked.'
        ),
        rated(
          'I applied exactly that fix and nothing changed: the same stall, ' +
            'so that memory was wrong for this.'
        )
      ])
      s.note({ 'worked-ratings': worked, 'failed-ratings': failed })
    },
    { reportOnly: true }
  )
}

const mode = process.argv[2]
if (mode !== 'single' && mode !== 'multi') {
  console.error('usage: validate.js <single|multi>')
  process.exit(2)
}

function prepareOrRefuse(mode: Mode) {
  try {
    return prepare(mode)
  } catch (error) {
    console.error(`refusing to start: ${(error as Error).message}`)
    process.exit(2)
  }
}

const setup = prepareOrRefuse(mode)

const identifiers =
  mode === 'single'
    ? { identity: "the token's own" }
    : {
        tenants: [acme, globex],
        networks: { [acme]: acmeNetwork, [globex]: globexNetwork },
        externalIds: {
          [alice.name]: alice.externalId,
          [bob.name]: bob.externalId,
          [carol.name]: carol.externalId
        }
      }

/** Remove this run's users, then the networks, which refuse to go with them. */
async function removeTenants(memco: Memco): Promise<void> {
  const attempt = (what: string, remove: () => Promise<unknown>) =>
    remove().catch((error: unknown) => {
      console.warn(`WARNING: could not remove ${what}: ${String(error)}`)
    })
  await Promise.all(
    [alice, bob, carol].map(({ externalId: id, name }) =>
      attempt(`user ${name}`, () => memco.users.delete(id))
    )
  )
  await Promise.all(
    [acmeNetwork, globexNetwork].map(name =>
      attempt(`network ${name}`, async () => {
        const { networks } = await memco.networks.list({ name })
        await Promise.all(networks.map(({ id }) => memco.networks.delete(id)))
      })
    )
  )
}

async function validate(mode: Mode): Promise<void> {
  const { status } = await eveInfo(setup)
  const server = await startServer(setup)
  const memco = new Memco(setup.memco)
  const client = mode === 'single' ? anonymous : alice.client
  try {
    await wiring(server, client, status)
    if (mode === 'single') await singleUser(memco, client)
    else await multiTenant(server, memco)
    await ending(server, client)
    // Independent sessions, each with its own nonce, and most of a run's time.
    if (process.env['VALIDATE_SAMPLES'] !== '0') {
      await Promise.all([
        reflection(client),
        sessionReflection(client),
        verdicts(client)
      ])
    }
  } finally {
    await server.stop()
    if (mode === 'multi' && process.env['VALIDATE_KEEP'] !== '1') {
      await removeTenants(memco)
    }
    await memco.close()
  }
}

console.log(`mode ${mode}, writing to Memco at ${setup.host}`)
console.log(`nonce ${nonce}, ticket class ${topic}`)

let fatal: string | undefined
try {
  await validate(mode)
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error)
  console.error(`FATAL ${fatal}`)
}

const failed = results.filter(result => result.status === 'FAIL')
const skipped = results.filter(result => result.status === 'SKIP')
console.log(
  `\n${results.length} scenarios: ${failed.length} failed, ${skipped.length} skipped`
)
console.log(
  JSON.stringify({ host: setup.host, nonce, topic, ...identifiers }, null, 2)
)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = join('examples/results', `${mode}-${stamp}.json`)
mkdirSync('examples/results', { recursive: true })
writeFileSync(
  output,
  JSON.stringify(
    { mode, host: setup.host, nonce, topic, ...identifiers, fatal, results },
    null,
    2
  )
)
console.log(`results in ${output}`)

process.exit(fatal === undefined && failed.length === 0 ? 0 : 1)
