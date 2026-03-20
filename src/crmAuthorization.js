const DEFAULT_ALLOWLIST = Object.freeze({
  create_note: {
    mode: 'allow',
  },
  create_lead: {
    mode: 'allow',
  },
  create_support_ticket: {
    mode: 'allow',
  },
  update_record: {
    mode: 'allow_limited_fields',
    allowedFields: [
      'company',
      'description',
      'email',
      'firstName',
      'lastName',
      'linkedinUrl',
      'notes',
      'phone',
      'title',
      'website',
    ],
    blockedFields: [
      'billingAddress',
      'billingEmail',
      'billingPlan',
      'billingStatus',
      'contractEndDate',
      'contractStartDate',
      'contractTerms',
      'monthlyRecurringRevenue',
      'ownerId',
      'pipelineStage',
      'renewalDate',
    ],
  },
  delete_record: {
    mode: 'require_manual_approval',
    reason: 'Deleting CRM records is sensitive and must be approved by a human.',
  },
  change_pipeline_stage: {
    mode: 'require_manual_approval',
    reason: 'Changing pipeline stage can affect forecasting and must be approved by a human.',
  },
  reassign_ownership: {
    mode: 'require_manual_approval',
    reason: 'Reassigning ownership affects account accountability and must be approved by a human.',
  },
  update_billing_or_contract: {
    mode: 'require_manual_approval',
    reason: 'Billing and contract updates are sensitive and must be approved by a human.',
  },
});

export class InMemoryAiActionLogger {
  constructor() {
    this.entries = [];
  }

  logOriginalRecommendation(entry) {
    this.entries.push({
      kind: 'original_recommendation',
      ...entry,
    });
  }

  logPermittedAction(entry) {
    this.entries.push({
      kind: 'permitted_action',
      ...entry,
    });
  }
}

export function authorizeAiCrmAction(recommendation, options = {}) {
  const logger = options.logger;
  const rules = options.rules ?? DEFAULT_ALLOWLIST;
  const timestamp = options.timestamp ?? new Date().toISOString();

  logger?.logOriginalRecommendation({
    recommendationId: recommendation.recommendationId,
    action: recommendation.action,
    target: recommendation.target,
    payload: recommendation.payload,
    actor: recommendation.actor,
    timestamp,
  });

  const rule = rules[recommendation.action];

  if (!rule) {
    return logAndReturn(logger, {
      recommendation,
      timestamp,
      status: 'blocked',
      finalAction: null,
      reason: `Action \"${recommendation.action}\" is not allowlisted for AI execution.`,
      manualApprovalRequired: true,
    });
  }

  if (rule.mode === 'allow') {
    return logAndReturn(logger, {
      recommendation,
      timestamp,
      status: 'permitted',
      finalAction: {
        action: recommendation.action,
        target: recommendation.target,
        payload: recommendation.payload,
      },
      reason: null,
      manualApprovalRequired: false,
    });
  }

  if (rule.mode === 'allow_limited_fields') {
    return authorizeLimitedFieldUpdate({ recommendation, rule, logger, timestamp });
  }

  if (rule.mode === 'require_manual_approval') {
    return logAndReturn(logger, {
      recommendation,
      timestamp,
      status: 'blocked',
      finalAction: null,
      reason: rule.reason,
      manualApprovalRequired: true,
    });
  }

  return logAndReturn(logger, {
    recommendation,
    timestamp,
    status: 'blocked',
    finalAction: null,
    reason: `Action \"${recommendation.action}\" has an unsupported authorization mode.`,
    manualApprovalRequired: true,
  });
}

function authorizeLimitedFieldUpdate({ recommendation, rule, logger, timestamp }) {
  const payload = recommendation.payload ?? {};
  const fields = Object.keys(payload);
  const blockedField = fields.find((field) => rule.blockedFields.includes(field));

  if (blockedField) {
    return logAndReturn(logger, {
      recommendation,
      timestamp,
      status: 'blocked',
      finalAction: null,
      reason: `Updating sensitive field \"${blockedField}\" requires manual approval.`,
      manualApprovalRequired: true,
    });
  }

  const disallowedField = fields.find((field) => !rule.allowedFields.includes(field));

  if (disallowedField) {
    return logAndReturn(logger, {
      recommendation,
      timestamp,
      status: 'blocked',
      finalAction: null,
      reason: `Field \"${disallowedField}\" is not allowlisted for AI updates.`,
      manualApprovalRequired: true,
    });
  }

  const sanitizedPayload = Object.fromEntries(
    fields.map((field) => [field, payload[field]]),
  );

  return logAndReturn(logger, {
    recommendation,
    timestamp,
    status: 'permitted',
    finalAction: {
      action: recommendation.action,
      target: recommendation.target,
      payload: sanitizedPayload,
    },
    reason: null,
    manualApprovalRequired: false,
  });
}

function logAndReturn(logger, result) {
  logger?.logPermittedAction({
    recommendationId: result.recommendation.recommendationId,
    originalAction: result.recommendation.action,
    status: result.status,
    finalAction: result.finalAction,
    reason: result.reason,
    manualApprovalRequired: result.manualApprovalRequired,
    timestamp: result.timestamp,
  });

  return {
    status: result.status,
    originalRecommendation: result.recommendation,
    finalAction: result.finalAction,
    reason: result.reason,
    manualApprovalRequired: result.manualApprovalRequired,
  };
}

export { DEFAULT_ALLOWLIST };
