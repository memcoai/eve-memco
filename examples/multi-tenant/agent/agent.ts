import { defineAgent } from 'eve'
import { anthropic } from 'eve/models/anthropic'

export default defineAgent({
  model: anthropic('claude-sonnet-5-5'),
  // The Memco SDK reads files from its own package at load, so eve must not
  // bundle it. @memco/eve stays bundled, and shares this project's eve.
  build: { externalDependencies: ['@memco/memcoai'] }
})
