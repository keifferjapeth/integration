const DEFAULT_ACKNOWLEDGMENT =
  'I\'m sorry — I\'m having trouble completing that automatically. I\'ve created a support handoff and a human will follow up shortly.';

/**
 * @typedef {Object} HandoffObject
 * @property {string} type
 * @property {string} reason
 * @property {string} userId
 * @property {string} source
 * @property {string} acknowledgment
 * @property {string} summary
 * @property {Object} metadata
 * @property {string} status
 * @property {string|null} crmRecordId
 */

/**
 * Creates a standard handoff object, persists it to the CRM as a ticket/task, and
 * returns a user-facing acknowledgment for bot.space.
 *
 * @param {Object} params
 * @param {string} params.reason
 * @param {string} params.userId
 * @param {string} params.source
 * @param {string} params.summary
 * @param {Object} [params.metadata]
 * @param {string} [params.acknowledgment]
 * @param {{createTask?: Function, createTicket?: Function}} params.crmClient
 * @returns {Promise<HandoffObject>}
 */
async function createStandardHandoff({
  reason,
  userId,
  source,
  summary,
  metadata = {},
  acknowledgment = DEFAULT_ACKNOWLEDGMENT,
  crmClient,
}) {
  if (!crmClient || (!crmClient.createTask && !crmClient.createTicket)) {
    throw new Error('CRM client must provide createTask or createTicket');
  }

  const payload = {
    type: 'human_handoff',
    reason,
    userId,
    source,
    acknowledgment,
    summary,
    metadata,
    requestedAt: new Date().toISOString(),
  };

  const writer = crmClient.createTask ?? crmClient.createTicket;
  const record = await writer(payload);

  return {
    ...payload,
    status: 'queued_for_human',
    crmRecordId: record?.id ?? null,
  };
}

module.exports = {
  DEFAULT_ACKNOWLEDGMENT,
  createStandardHandoff,
};
