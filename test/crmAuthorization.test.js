import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeAiCrmAction,
  InMemoryAiActionLogger,
} from '../src/index.js';

test('permits allowlisted create note action and logs original and permitted entries separately', () => {
  const logger = new InMemoryAiActionLogger();

  const result = authorizeAiCrmAction(
    {
      recommendationId: 'rec-1',
      actor: 'ai-agent',
      action: 'create_note',
      target: { type: 'contact', id: 'contact-123' },
      payload: { text: 'Follow up next week.' },
    },
    { logger, timestamp: '2026-03-20T00:00:00.000Z' },
  );

  assert.equal(result.status, 'permitted');
  assert.equal(result.manualApprovalRequired, false);
  assert.deepEqual(result.finalAction, {
    action: 'create_note',
    target: { type: 'contact', id: 'contact-123' },
    payload: { text: 'Follow up next week.' },
  });

  assert.equal(logger.entries.length, 2);
  assert.equal(logger.entries[0].kind, 'original_recommendation');
  assert.equal(logger.entries[1].kind, 'permitted_action');
  assert.equal(logger.entries[1].status, 'permitted');
});

test('permits only limited non-critical field updates', () => {
  const result = authorizeAiCrmAction({
    recommendationId: 'rec-2',
    actor: 'ai-agent',
    action: 'update_record',
    target: { type: 'lead', id: 'lead-123' },
    payload: {
      firstName: 'Taylor',
      phone: '+1-555-0100',
      notes: 'Requested callback after product demo.',
    },
  });

  assert.equal(result.status, 'permitted');
  assert.deepEqual(result.finalAction?.payload, {
    firstName: 'Taylor',
    phone: '+1-555-0100',
    notes: 'Requested callback after product demo.',
  });
});

test('blocks updates to pipeline stage and other sensitive fields', () => {
  const result = authorizeAiCrmAction({
    recommendationId: 'rec-3',
    actor: 'ai-agent',
    action: 'update_record',
    target: { type: 'opportunity', id: 'opp-999' },
    payload: {
      pipelineStage: 'Closed Won',
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.manualApprovalRequired, true);
  assert.match(result.reason, /pipelineStage/);
  assert.equal(result.finalAction, null);
});

test('blocks non-allowlisted record deletion', () => {
  const result = authorizeAiCrmAction({
    recommendationId: 'rec-4',
    actor: 'ai-agent',
    action: 'delete_record',
    target: { type: 'account', id: 'acct-777' },
    payload: {},
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.manualApprovalRequired, true);
  assert.match(result.reason, /Deleting CRM records/);
});

test('blocks unrecognized actions by default', () => {
  const result = authorizeAiCrmAction({
    recommendationId: 'rec-5',
    actor: 'ai-agent',
    action: 'merge_duplicate_records',
    target: { type: 'account', id: 'acct-999' },
    payload: {},
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.manualApprovalRequired, true);
  assert.match(result.reason, /not allowlisted/);
});
