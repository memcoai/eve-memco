import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionAuthContext } from 'eve/context'

import { externalId, networkName } from '../src/derive.js'

const PRINCIPAL: SessionAuthContext = {
  attributes: {},
  authenticator: 'oidc',
  issuer: 'https://id.example.com',
  principalId: 'user-1',
  principalType: 'user'
}

test('a fixed input derives a fixed external id and network name', () => {
  // Changing either value is a data migration: every tenant's existing users
  // and networks would be orphaned and their memory start over from empty.
  assert.equal(
    externalId('acme-app', 'tenant-a', PRINCIPAL),
    'eve-64e92c684cefb50b01088daa46d0721db63e1d5162ee75859e9aa1e4a24ec307'
  )
  assert.equal(
    networkName('acme-app', 'tenant-a', 'knowledge'),
    'eve-knowledge-336bafb75e58949b2a5075c2463b467f8d5a5d2a20100f577b03e2359a72f90b'
  )
})

test('parts that concatenate alike still derive different external ids', () => {
  assert.notEqual(
    externalId('acme', '1user', { ...PRINCIPAL, principalId: '23' }),
    externalId('acme1', 'user', { ...PRINCIPAL, principalId: '23' })
  )
  assert.notEqual(
    externalId('app', 'acme1', { ...PRINCIPAL, principalId: '23' }),
    externalId('app', 'acme', { ...PRINCIPAL, principalId: '123' })
  )
})

test('each part of the external id changes it on its own', () => {
  const base = externalId('app', 'tenant', PRINCIPAL)
  const variants = [
    externalId('other-app', 'tenant', PRINCIPAL),
    externalId('app', 'other-tenant', PRINCIPAL),
    externalId('app', 'tenant', { ...PRINCIPAL, principalType: 'service' }),
    externalId('app', 'tenant', { ...PRINCIPAL, authenticator: 'saml' }),
    externalId('app', 'tenant', { ...PRINCIPAL, issuer: 'https://other' }),
    externalId('app', 'tenant', { ...PRINCIPAL, principalId: 'user-2' })
  ]
  for (const variant of variants) {
    assert.notEqual(variant, base)
  }
  assert.equal(new Set(variants).size, variants.length)
})

test('a missing issuer derives a stable id apart from an empty one', () => {
  const { issuer: _, ...noIssuer } = PRINCIPAL
  assert.equal(
    externalId('app', 'tenant', noIssuer),
    externalId('app', 'tenant', noIssuer)
  )
  assert.notEqual(
    externalId('app', 'tenant', noIssuer),
    externalId('app', 'tenant', { ...PRINCIPAL, issuer: '' })
  )
})

test('the principal attributes play no part in the external id', () => {
  assert.equal(
    externalId('app', 'tenant', { ...PRINCIPAL, attributes: { role: 'x' } }),
    externalId('app', 'tenant', PRINCIPAL)
  )
})

test('each part of the network name changes it on its own', () => {
  const base = networkName('app', 'tenant', 'knowledge')
  const variants = [
    networkName('other-app', 'tenant', 'knowledge'),
    networkName('app', 'other-tenant', 'knowledge'),
    networkName('app', 'tenant', 'coding')
  ]
  for (const variant of variants) {
    assert.notEqual(variant, base)
  }
})

test('a network name has a fixed length within a domain, whatever the inputs', () => {
  const short = networkName('a', 'b', 'knowledge')
  const long = networkName('a'.repeat(1024), 'b'.repeat(1024), 'knowledge')
  assert.equal(long.length, short.length)
  assert.match(short, /^eve-knowledge-[0-9a-f]{64}$/)
})
