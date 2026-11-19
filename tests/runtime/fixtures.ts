import { configSchema, stages, taskSchema, type State } from '../../src/types.js';

/** Synthetic control records for unit tests; never imported by the application. */
export function testConfig() {
  return configSchema.parse({
    executor: { baseUrl: 'http://127.0.0.1:1/v1', model: 'test-executor', family: 'executor', apiKeyEnv: 'TEST_RUNTIME_UNUSED_KEY' },
    reviewer: { baseUrl: 'http://127.0.0.1:1/v1', model: 'test-reviewer', family: 'reviewer', apiKeyEnv: 'TEST_RUNTIME_UNUSED_KEY' },
    maxRequests: 120, maxWallSeconds: 7200,
  });
}

export function testState(): State {
  const state: State = {
    version: 1, goal: 'Unit test', mode: 'automatic', config: testConfig(),
    topic: { version: 1, status: 'APPROVED' },
    researchInputs: { revision: 0, paperType: null, seedPapers: [], targetJournal: null },
    tasks: {}, sessions: { main: { messages: [], inbox: [] } },
    sources: {}, claims: {}, challenges: {}, edges: [], events: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, unknownRequests: 0 },
  };
  for (const id of [...stages, 'robustness']) {
    state.tasks[id] = {
      ...taskSchema.parse({ id, stage: id === 'robustness' ? 'analysis' : id, prompt: `Test ${id}`, outputs: [`${id}.txt`], writes: [`${id}.txt`] }),
      execution: 'pending', acceptance: 'pending', attempts: 0, topicVersion: 1,
      inputHashes: {}, outputHashes: {}, reasons: [], claimIds: [], retrievals: [],
      children: [], elapsedSeconds: 0, noProgress: 0,
    };
  }
  return state;
}
