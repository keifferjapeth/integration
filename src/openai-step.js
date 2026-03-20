import schema from './openai-step-response-schema.json' with { type: 'json' };

export const OPENAI_STEP_RESPONSE_SCHEMA = schema;

const ALLOWED_CRM_ACTIONS = new Set(schema.properties.crm_action.enum);

export const SAFE_FALLBACK_RESPONSE = Object.freeze({
  intent: 'fallback',
  confidence: 0,
  reply_text:
    'Thanks for your message. I could not confidently process the request, so I am routing it to a human teammate for follow-up.',
  requires_handoff: true,
  crm_action: 'none',
  crm_payload: null,
  reason: 'Fallback response returned because the OpenAI step output failed validation.'
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateOpenAIStepResponse(candidate) {
  const errors = [];

  if (!isPlainObject(candidate)) {
    return {
      valid: false,
      errors: ['Response must be a JSON object.']
    };
  }

  const requiredFields = [
    'intent',
    'confidence',
    'reply_text',
    'requires_handoff',
    'crm_action',
    'crm_payload',
    'reason'
  ];

  const allowedFields = new Set(requiredFields);

  for (const key of requiredFields) {
    if (!(key in candidate)) {
      errors.push(`Missing required field: ${key}.`);
    }
  }

  for (const key of Object.keys(candidate)) {
    if (!allowedFields.has(key)) {
      errors.push(`Unexpected field present: ${key}.`);
    }
  }

  if (typeof candidate.intent !== 'string' || candidate.intent.trim().length === 0) {
    errors.push('intent must be a non-empty string.');
  }

  if (
    typeof candidate.confidence !== 'number' ||
    Number.isNaN(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    errors.push('confidence must be a number between 0 and 1.');
  }

  if (typeof candidate.reply_text !== 'string' || candidate.reply_text.trim().length === 0) {
    errors.push('reply_text must be a non-empty string.');
  }

  if (typeof candidate.requires_handoff !== 'boolean') {
    errors.push('requires_handoff must be a boolean.');
  }

  if (typeof candidate.crm_action !== 'string' || !ALLOWED_CRM_ACTIONS.has(candidate.crm_action)) {
    errors.push(`crm_action must be one of: ${Array.from(ALLOWED_CRM_ACTIONS).join(', ')}.`);
  }

  if (typeof candidate.reason !== 'string' || candidate.reason.trim().length === 0) {
    errors.push('reason must be a non-empty string.');
  }

  if (candidate.crm_action === 'none') {
    if (candidate.crm_payload !== null) {
      errors.push('crm_payload must be null when crm_action is none.');
    }
  } else if (!isPlainObject(candidate.crm_payload)) {
    errors.push('crm_payload must be an object when crm_action requests a CRM write.');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function buildOpenAIStepResult(rawResponse, { logger = console } = {}) {
  const validation = validateOpenAIStepResponse(rawResponse);

  if (!validation.valid) {
    logger.error('Invalid OpenAI step response detected.', {
      errors: validation.errors,
      rawResponse
    });

    return {
      response: SAFE_FALLBACK_RESPONSE,
      validation,
      shouldExecuteCrmWrite: false
    };
  }

  return {
    response: rawResponse,
    validation,
    shouldExecuteCrmWrite: rawResponse.crm_action !== 'none'
  };
}
