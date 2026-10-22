import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentExplain } from './explain.mjs';
import { setRun } from '../runs/store.js';

function makeMockRun({ arrayHistory, steps, algorithm }) {
  const runId = 'run-' + Math.random().toString(36).slice(2);
  setRun(runId, { arrayHistory, steps, algorithm: algorithm || 'binary-search' });
  return { runId };
}

describe('Agent Explain (PR #18 fixes)', () => {
  it('P2: rejects non-number stepIndex (no coercion)', async () => {
    const run = makeMockRun({
      arrayHistory: [[1, 2, 3]],
      steps: [{ event: 'probe', variables: { left: 0, right: 2, mid: 1 }, target: 2, array: [1, 2, 3] }],
    });
    const result = await handleAgentExplain(
      { runId: run.runId, stepIndex: '1', question: '为什么 mid 是 1？', hintLevel: 1 },
      { mode: 'mock', req: { socket: { remoteAddress: '127.0.0.1' } } }
    );
    assert.equal(result.status, 400);
  });

  it('P2: empty array init step returns correct explanation', async () => {
    const run = makeMockRun({
      arrayHistory: [[]],
      steps: [{ event: 'init', variables: { left: 0, right: -1 }, target: 1, array: [] }],
    });
    const result = await handleAgentExplain(
      { runId: run.runId, stepIndex: 0, question: '为什么找不到？', hintLevel: 1 },
      { mode: 'mock', req: { socket: { remoteAddress: '127.0.0.1' } } }
    );
    assert.equal(result.status, 200);
    assert.ok(result.body.answer.includes('区间为空'));
  });

  it('Mock cost is null (contract fix)', async () => {
    const run = makeMockRun({
      arrayHistory: [[1, 2, 3]],
      steps: [{ event: 'probe', variables: { left: 0, right: 2, mid: 1 }, target: 2, array: [1, 2, 3] }],
    });
    const result = await handleAgentExplain(
      { runId: run.runId, stepIndex: 0, question: '为什么？', hintLevel: 1 },
      { mode: 'mock', req: { socket: { remoteAddress: '127.0.0.1' } } }
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.usage.cost, null);
  });

  it('P2: rejects negative stepIndex', async () => {
    const run = makeMockRun({
      arrayHistory: [[1, 2, 3]],
      steps: [{ event: 'probe', variables: { left: 0, right: 2, mid: 1 }, target: 2, array: [1, 2, 3] }],
    });
    const result = await handleAgentExplain(
      { runId: run.runId, stepIndex: -1, question: '为什么？', hintLevel: 1 },
      { mode: 'mock', req: { socket: { remoteAddress: '127.0.0.1' } } }
    );
    assert.equal(result.status, 400);
  });

  it('P2: rejects empty question', async () => {
    const run = makeMockRun({
      arrayHistory: [[1, 2, 3]],
      steps: [{ event: 'probe', variables: { left: 0, right: 2, mid: 1 }, target: 2, array: [1, 2, 3] }],
    });
    const result = await handleAgentExplain(
      { runId: run.runId, stepIndex: 0, question: '', hintLevel: 1 },
      { mode: 'mock', req: { socket: { remoteAddress: '127.0.0.1' } } }
    );
    assert.equal(result.status, 400);
  });
});