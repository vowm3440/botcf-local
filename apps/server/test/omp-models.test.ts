import { describe, expect, it } from 'vitest'
import { buildBotcfModelsConfig } from '../src/omp/rpc.js'

describe('buildBotcfModelsConfig', () => {
  it('maps routes to proxy-backed providers and preserves effective context', () => {
    const config = buildBotcfModelsConfig([
      { model_id: 'gpt-test', api_type: 'responses', effective_context: 1_000_000, max_output: 32_768 },
      { model_id: 'gpt-test', api_type: 'responses', effective_context: 400_000, max_output: 8_192 },
      { model_id: 'claude-test', api_type: 'messages', effective_context: 200_000, max_output: 16_384 }
    ], 'http://127.0.0.1:7789', 'test-proxy-capability')

    expect(config.providers['botcf-responses'].baseUrl).toBe('http://127.0.0.1:7789/v1')
    expect(config.providers['botcf-responses'].apiKey).toBe('test-proxy-capability')
    expect(config.providers['botcf-responses'].models).toContainEqual(expect.objectContaining({
      id: 'gpt-test', contextWindow: 1_000_000, maxTokens: 32_768, supportsTools: true
    }))
    expect(config.providers['botcf-messages'].baseUrl).toBe('http://127.0.0.1:7789')
    expect(config.providers['botcf-messages'].models[0].api).toBe('anthropic-messages')
  })
})
