import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionAuthContext } from 'eve/context'
import type { MemoryScopeContext } from 'eve/memory'

import { TENANT_SCOPE, byTenant } from '../src/scope.js'

const USER: SessionAuthContext = {
  attributes: { tenantId: 'tenant-a' },
  authenticator: 'oidc',
  principalId: 'user-1',
  principalType: 'user'
}

function context(current: SessionAuthContext | null): MemoryScopeContext {
  return {
    abortSignal: new AbortController().signal,
    session: { id: 'session-1', auth: { current, initiator: current } },
    channel: {} as MemoryScopeContext['channel']
  }
}

const fromAttribute = (principal: SessionAuthContext) => {
  const tenant = principal.attributes['tenantId']
  return typeof tenant === 'string' ? tenant : null
}

test('a user principal is scoped to its tenant', async () => {
  const scope = byTenant(fromAttribute)
  assert.deepEqual(await scope(context(USER)), [TENANT_SCOPE, 'tenant-a'])
})

test('the resolver may answer asynchronously', async () => {
  const scope = byTenant(async () => 'tenant-b')
  assert.deepEqual(await scope(context(USER)), [TENANT_SCOPE, 'tenant-b'])
})

test('memory is off with no principal', async () => {
  const scope = byTenant(fromAttribute)
  assert.equal(await scope(context(null)), null)
})

test('memory is off for a principal that is not a user', async () => {
  const scope = byTenant(fromAttribute)
  for (const principalType of [
    'service',
    'anonymous',
    'runtime',
    'local-dev'
  ]) {
    assert.equal(await scope(context({ ...USER, principalType })), null)
  }
})

test('memory is off when the tenant cannot be resolved', async () => {
  for (const tenant of [null, undefined, '']) {
    const scope = byTenant(() => tenant)
    assert.equal(await scope(context(USER)), null)
  }
})

test('the resolver is never asked about a principal that is not a user', async () => {
  let asked = false
  const scope = byTenant(() => {
    asked = true
    return 'tenant-a'
  })
  await scope(context({ ...USER, principalType: 'service' }))
  assert.equal(asked, false)
})
