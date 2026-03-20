const test = require('node:test');
const assert = require('node:assert/strict');

const { createStandardHandoff, DEFAULT_ACKNOWLEDGMENT } = require('../src/handoff');
const { processBotSpaceWebhook } = require('../src/workflow');

function createDeps(overrides = {}) {
  const handoffRecords = [];
  const dedupValues = new Set();

  return {
    handoffRecords,
    dedupStore: {
      has: (id) => dedupValues.has(id),
      add: (id) => dedupValues.add(id),
    },
    crmClient: {
      lookupContactByExternalId: async (id) => ({ id: `crm-${id}` }),
      createTask: async (payload) => {
        handoffRecords.push(payload);
        return { id: `task-${handoffRecords.length}` };
      },
      ...(overrides.crmClient || {}),
    },
    openAiClient: {
      respond: async () => ({ reply: 'Automated reply', intent: 'answer' }),
      ...(overrides.openAiClient || {}),
    },
  };
}

function createEvent(overrides = {}) {
  return {
    deliveryId: 'delivery-1',
    conversationId: 'conversation-1',
    user: {
      id: 'user-1',
      crmContactId: 'crm-user-1',
      ...(overrides.user || {}),
    },
    message: {
      text: 'Need help with my account',
      ...(overrides.message || {}),
    },
    ...overrides,
  };
}

test('createStandardHandoff writes a CRM task and returns a bot.space acknowledgment', async () => {
  const calls = [];
  const handoff = await createStandardHandoff({
    reason: 'crm_unavailable',
    userId: 'user-9',
    source: 'bot.space',
    summary: 'CRM is unavailable',
    crmClient: {
      createTask: async (payload) => {
        calls.push(payload);
        return { id: 'task-99' };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(handoff.crmRecordId, 'task-99');
  assert.equal(handoff.status, 'queued_for_human');
  assert.equal(handoff.acknowledgment, DEFAULT_ACKNOWLEDGMENT);
});

test('duplicate webhook delivery is ignored', async () => {
  const deps = createDeps();
  const event = createEvent();
  deps.dedupStore.add(event.deliveryId);

  const result = await processBotSpaceWebhook(event, deps);

  assert.equal(result.status, 'duplicate_ignored');
  assert.equal(deps.handoffRecords.length, 0);
});

test('CRM timeout creates a handoff', async () => {
  const deps = createDeps({
    crmClient: {
      lookupContactByExternalId: async () => {
        const error = new Error('CRM timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      },
    },
  });

  const result = await processBotSpaceWebhook(createEvent(), deps);

  assert.equal(result.status, 'handoff_created');
  assert.equal(result.handoff.reason, 'crm_unavailable');
  assert.equal(deps.handoffRecords.length, 1);
});

test('identity mismatch creates a handoff', async () => {
  const deps = createDeps({
    crmClient: {
      lookupContactByExternalId: async () => ({ id: 'crm-someone-else' }),
    },
  });

  const result = await processBotSpaceWebhook(createEvent(), deps);

  assert.equal(result.status, 'handoff_created');
  assert.equal(result.handoff.reason, 'identity_mismatch');
});

test('OpenAI timeout creates a handoff', async () => {
  const deps = createDeps({
    openAiClient: {
      respond: async () => {
        const error = new Error('OpenAI timeout');
        error.name = 'AbortError';
        throw error;
      },
    },
  });

  const result = await processBotSpaceWebhook(createEvent(), deps);

  assert.equal(result.status, 'handoff_created');
  assert.equal(result.handoff.reason, 'openai_timeout');
});

test('invalid structured output creates a handoff', async () => {
  const deps = createDeps({
    openAiClient: {
      respond: async () => ({ reply: '', no_intent: true }),
    },
  });

  const result = await processBotSpaceWebhook(createEvent(), deps);

  assert.equal(result.status, 'handoff_created');
  assert.equal(result.handoff.reason, 'invalid_structured_output');
});

test('user request for a human creates a handoff without calling OpenAI', async () => {
  let openAiCalled = false;
  const deps = createDeps({
    openAiClient: {
      respond: async () => {
        openAiCalled = true;
        return { reply: 'Automated reply', intent: 'answer' };
      },
    },
  });

  const result = await processBotSpaceWebhook(
    createEvent({ message: { text: 'Can I talk to a human agent?' } }),
    deps,
  );

  assert.equal(result.status, 'handoff_created');
  assert.equal(result.handoff.reason, 'human_requested');
  assert.equal(openAiCalled, false);
});

test('valid path returns an automated reply', async () => {
  const deps = createDeps();

  const result = await processBotSpaceWebhook(createEvent(), deps);

  assert.equal(result.status, 'replied');
  assert.equal(result.ack, 'Automated reply');
  assert.equal(result.crmContactId, 'crm-user-1');
});
