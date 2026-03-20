const { createStandardHandoff, DEFAULT_ACKNOWLEDGMENT } = require('./handoff');

const HUMAN_REQUEST_PATTERN = /\b(human|person|agent|representative|support)\b/i;

function isTimeoutError(error) {
  return Boolean(
    error &&
      (error.name === 'AbortError' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNABORTED' ||
        /timeout/i.test(error.message || '')),
  );
}

function isStructuredOutputValid(output) {
  return Boolean(
    output &&
      typeof output === 'object' &&
      typeof output.reply === 'string' &&
      output.reply.trim() &&
      typeof output.intent === 'string' &&
      output.intent.trim(),
  );
}

function buildDuplicateResponse(event) {
  return {
    status: 'duplicate_ignored',
    deliveryId: event.deliveryId,
    message: 'Duplicate webhook delivery ignored.',
    ack: null,
    handoff: null,
  };
}

async function safeLookupContact(crmClient, externalUserId) {
  try {
    return await crmClient.lookupContactByExternalId(externalUserId);
  } catch (error) {
    if (isTimeoutError(error)) {
      return { timeout: true };
    }

    throw error;
  }
}

async function createHandoffFromReason({ event, crmClient, reason, summary, metadata = {}, acknowledgment }) {
  const handoff = await createStandardHandoff({
    reason,
    userId: event.user.id,
    source: 'bot.space',
    summary,
    metadata: {
      deliveryId: event.deliveryId,
      conversationId: event.conversationId,
      ...metadata,
    },
    acknowledgment,
    crmClient,
  });

  return {
    status: 'handoff_created',
    deliveryId: event.deliveryId,
    message: summary,
    ack: handoff.acknowledgment,
    handoff,
  };
}

/**
 * Main bot.space webhook processor with explicit fallback handling.
 *
 * @param {Object} event
 * @param {string} event.deliveryId
 * @param {string} event.conversationId
 * @param {{id: string, crmContactId?: string|null}} event.user
 * @param {{text: string}} event.message
 * @param {Object} dependencies
 * @param {{has: Function, add: Function}} dependencies.dedupStore
 * @param {{lookupContactByExternalId: Function, createTask?: Function, createTicket?: Function}} dependencies.crmClient
 * @param {{respond: Function}} dependencies.openAiClient
 */
async function processBotSpaceWebhook(event, { dedupStore, crmClient, openAiClient }) {
  if (dedupStore.has(event.deliveryId)) {
    return buildDuplicateResponse(event);
  }

  dedupStore.add(event.deliveryId);

  if (HUMAN_REQUEST_PATTERN.test(event.message.text)) {
    return createHandoffFromReason({
      event,
      crmClient,
      reason: 'human_requested',
      summary: 'User explicitly requested a human handoff.',
      acknowledgment: 'Absolutely — I\'ve routed this conversation to a human teammate for follow-up.',
      metadata: {
        transcriptSnippet: event.message.text,
      },
    });
  }

  const contact = await safeLookupContact(crmClient, event.user.id);

  if (contact?.timeout || !contact) {
    return createHandoffFromReason({
      event,
      crmClient,
      reason: 'crm_unavailable',
      summary: 'CRM lookup timed out or returned unavailable during bot.space webhook processing.',
      metadata: {
        contactLookupState: contact?.timeout ? 'timeout' : 'missing',
      },
    });
  }

  if (event.user.crmContactId && contact.id !== event.user.crmContactId) {
    return createHandoffFromReason({
      event,
      crmClient,
      reason: 'identity_mismatch',
      summary: 'bot.space user identity does not match the CRM contact on record.',
      acknowledgment:
        'I found conflicting account details, so I\'ve asked a human teammate to review this conversation.',
      metadata: {
        botSpaceCrmContactId: event.user.crmContactId,
        crmContactId: contact.id,
      },
    });
  }

  let aiResult;
  try {
    aiResult = await openAiClient.respond({
      contact,
      message: event.message.text,
      conversationId: event.conversationId,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      return createHandoffFromReason({
        event,
        crmClient,
        reason: 'openai_timeout',
        summary: 'OpenAI response timed out during bot.space webhook processing.',
        metadata: {
          error: error.message,
        },
      });
    }

    throw error;
  }

  if (!isStructuredOutputValid(aiResult)) {
    return createHandoffFromReason({
      event,
      crmClient,
      reason: 'invalid_structured_output',
      summary: 'OpenAI returned invalid structured output and the request was escalated.',
      metadata: {
        rawResponse: aiResult,
      },
    });
  }

  return {
    status: 'replied',
    deliveryId: event.deliveryId,
    message: 'Reply generated successfully.',
    ack: aiResult.reply,
    handoff: null,
    intent: aiResult.intent,
    crmContactId: contact.id,
  };
}

module.exports = {
  DEFAULT_ACKNOWLEDGMENT,
  HUMAN_REQUEST_PATTERN,
  isStructuredOutputValid,
  processBotSpaceWebhook,
};
