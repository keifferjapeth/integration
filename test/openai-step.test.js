import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOpenAIStepResult,
  OPENAI_STEP_RESPONSE_SCHEMA,
  SAFE_FALLBACK_RESPONSE,
  validateOpenAIStepResponse
} from '../src/openai-step.js';

test('exports a strict schema with required fields', () => {
  assert.equal(OPENAI_STEP_RESPONSE_SCHEMA.additionalProperties, false);
  assert.deepEqual(OPENAI_STEP_RESPONSE_SCHEMA.required, [
    'intent',
    'confidence',
    'reply_text',
    'requires_handoff',
    'crm_action',
    'crm_payload',
    'reason'
  ]);
});

test('accepts a valid non-writing response', () => {
  const result = validateOpenAIStepResponse({
    intent: 'answer_question',
    confidence: 0.92,
    reply_text: 'Here is the answer.',
    requires_handoff: false,
    crm_action: 'none',
    crm_payload: null,
    reason: 'The user only needed product information.'
  });

  assert.deepEqual(result, {
    valid: true,
    errors: []
  });
});

test('rejects unexpected fields and malformed CRM payloads', () => {
  const result = validateOpenAIStepResponse({
    intent: 'create_lead',
    confidence: 2,
    reply_text: '',
    requires_handoff: 'no',
    crm_action: 'create_lead',
    crm_payload: null,
    reason: '',
    extra_field: true
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Unexpected field present: extra_field\./);
  assert.match(result.errors.join('\n'), /confidence must be a number between 0 and 1\./);
  assert.match(result.errors.join('\n'), /reply_text must be a non-empty string\./);
  assert.match(result.errors.join('\n'), /requires_handoff must be a boolean\./);
  assert.match(result.errors.join('\n'), /crm_payload must be an object when crm_action requests a CRM write\./);
});

test('returns a safe fallback and suppresses CRM writes when validation fails', () => {
  const calls = [];
  const logger = {
    error(message, payload) {
      calls.push({ message, payload });
    }
  };

  const result = buildOpenAIStepResult(
    {
      intent: 'update_contact',
      confidence: 0.55,
      reply_text: 'I updated the CRM.',
      requires_handoff: false,
      crm_action: 'update_contact',
      crm_payload: null,
      reason: 'The user shared a new phone number.'
    },
    { logger }
  );

  assert.deepEqual(result.response, SAFE_FALLBACK_RESPONSE);
  assert.equal(result.shouldExecuteCrmWrite, false);
  assert.equal(result.validation.valid, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /Invalid OpenAI step response detected\./);
  assert.deepEqual(calls[0].payload.rawResponse.crm_action, 'update_contact');
});

test('allows CRM writes only after validation passes', () => {
  const result = buildOpenAIStepResult({
    intent: 'create_lead',
    confidence: 0.97,
    reply_text: 'I will have our team reach out shortly.',
    requires_handoff: false,
    crm_action: 'create_lead',
    crm_payload: {
      email: 'prospect@example.com',
      source: 'web'
    },
    reason: 'The user requested a sales follow-up.'
  });

  assert.equal(result.validation.valid, true);
  assert.equal(result.shouldExecuteCrmWrite, true);
  assert.equal(result.response.crm_action, 'create_lead');
});
