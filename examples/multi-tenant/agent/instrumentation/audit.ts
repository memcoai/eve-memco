import { defineInstrumentation } from 'eve/instrumentation'

interface AuditedEvent {
  type: string
  phase?: string
  slot?: string
  operationName?: string
  outcome?: string
  sessionId: string
}

// Named fields only, so memory content never reaches the log.
function audit(event: AuditedEvent) {
  const { type, phase, slot, operationName, outcome, sessionId } = event
  const line = { type, phase, slot, operationName, outcome, sessionId }
  console.log(`[audit] ${JSON.stringify(line)}`)
}

export default defineInstrumentation({
  tracePolicy: () => ({
    emit: true,
    recordInputs: false,
    recordOutputs: false
  }),
  events: {
    'memory.operation.started': audit,
    'memory.operation.settled': audit,
    'session.ended': audit
  }
})
