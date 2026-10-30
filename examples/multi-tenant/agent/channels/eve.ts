import { localDev, type AuthFn } from 'eve/channels/auth'
import { eveChannel } from 'eve/channels/eve'

// Trusts the request's headers: anyone who can reach the server can claim any
// user of any tenant. For local validation only; a real deployment verifies
// the caller here instead, and stamps the verified tenant the same way.
const devHeaders: AuthFn<Request> = request => {
  if (process.env['EXAMPLE_TEST_AUTH'] !== '1') return null

  const user = request.headers.get('x-test-user')
  const tenantId = request.headers.get('x-test-tenant')
  if (user === null || tenantId === null) return null

  return {
    authenticator: 'dev-headers',
    principalId: user,
    principalType: 'user',
    attributes: { tenantId }
  }
}

export default eveChannel({
  auth: [devHeaders, localDev()]
})
