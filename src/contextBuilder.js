const DEFAULT_BOT_SPACE_LIMIT = 4;

const SENSITIVE_FIELD_PATTERNS = [
  /(^|\.)phone(number)?$/i,
  /(^|\.)mobile$/i,
  /(^|\.)payment/i,
  /(^|\.)card/i,
  /(^|\.)cvv$/i,
  /(^|\.)iban$/i,
  /(^|\.)routing(number)?$/i,
  /(^|\.)account(number)?$/i,
  /(^|\.)tax(id)?$/i,
  /(^|\.)ssn$/i,
  /(^|\.)government(id)?$/i,
  /(^|\.)passport(number)?$/i,
  /(^|\.)driver.?license/i,
  /(^|\.)national(id)?$/i,
  /(^|\.)internal(Only)?Notes?$/i,
  /(^|\.)notesInternal$/i,
  /(^|\.)privateNotes?$/i,
];

const REDACTION_RULES = {
  phone: {
    label: 'PHONE',
    pattern: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g,
  },
  payment: {
    label: 'PAYMENT',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
  },
  id: {
    label: 'ID',
    pattern: /\b(?=[A-Z0-9-]{6,}\b)(?=.*[A-Z])(?=.*\d)[A-Z0-9-]+\b/gi,
  },
};

export function buildContextPrompt(input) {
  const {
    currentUserMessage,
    conversation = [],
    crm = {},
    ticketSummary = '',
    orderSummary = '',
    businessRules = '',
    escalationPolicy = '',
    botSpaceLimit = DEFAULT_BOT_SPACE_LIMIT,
    crmFieldAllowlist = [],
    includeEmptySections = false,
  } = input;

  const normalizedAllowlist = crmFieldAllowlist.map(normalizePath);
  const crmFields = collectCrmFields({
    crm,
    allowlist: normalizedAllowlist,
  });

  const sections = [
    createSection('Current user message', sanitizeText(currentUserMessage)),
    createSection('Recent bot.space messages', formatMessages(conversation, botSpaceLimit)),
    createSection('CRM fields', formatCrmFields(crmFields)),
    createSection('Recent ticket/order summary', formatSummary(ticketSummary, orderSummary)),
    createSection('Business rules', sanitizeText(businessRules)),
    createSection('Escalation policy', sanitizeText(escalationPolicy)),
  ].filter((section) => includeEmptySections || section.content);

  return {
    sections,
    prompt: sections
      .map((section) => `## ${section.title}\n${section.content}`)
      .join('\n\n')
      .trim(),
    metadata: {
      includedCrmFieldPaths: crmFields.map((field) => field.path),
      redactedCrmFieldPaths: crmFields.filter((field) => field.wasRedacted).map((field) => field.path),
      omittedSensitiveCrmFieldPaths: listOmittedSensitiveFields(crm, normalizedAllowlist),
      includedBotSpaceMessageIds: lastBotSpaceMessages(conversation, botSpaceLimit).map((message) => message.id).filter(Boolean),
    },
  };
}

function createSection(title, content) {
  return {
    title,
    content: content?.trim() ?? '',
  };
}

function formatMessages(conversation, limit) {
  const messages = lastBotSpaceMessages(conversation, limit);

  return messages
    .map((message, index) => {
      const prefix = message.createdAt ? `[${message.createdAt}] ` : '';
      return `${index + 1}. ${prefix}${sanitizeText(message.content)}`;
    })
    .join('\n');
}

function lastBotSpaceMessages(conversation, limit) {
  return conversation
    .filter((message) => message?.source === 'bot.space' && message?.content)
    .slice(-limit);
}

function formatSummary(ticketSummary, orderSummary) {
  const blocks = [];

  if (ticketSummary) {
    blocks.push(`Ticket: ${sanitizeText(ticketSummary)}`);
  }

  if (orderSummary) {
    blocks.push(`Order: ${sanitizeText(orderSummary)}`);
  }

  return blocks.join('\n');
}

function formatCrmFields(fields) {
  return fields
    .map(({ path, value }) => `- ${path}: ${value}`)
    .join('\n');
}

function collectCrmFields({ crm, allowlist }) {
  const flattened = flattenObject(crm);

  return flattened
    .filter(({ value }) => value !== undefined && value !== null && value !== '')
    .filter(({ path }) => shouldIncludeField(path, allowlist))
    .map(({ path, value }) => {
      const sensitive = isSensitiveField(path);
      const redactedValue = sensitive ? redactValue(path, value) : sanitizeText(value);

      return {
        path,
        value: redactedValue,
        wasRedacted: sensitive && redactedValue !== sanitizeText(value),
      };
    });
}

function listOmittedSensitiveFields(crm, allowlist) {
  return flattenObject(crm)
    .filter(({ path, value }) => value !== undefined && value !== null && value !== '')
    .filter(({ path }) => isSensitiveField(path) && !matchesAllowlist(path, allowlist))
    .map(({ path }) => path);
}

function shouldIncludeField(path, allowlist) {
  if (!path) {
    return false;
  }

  if (isSensitiveField(path)) {
    return matchesAllowlist(path, allowlist);
  }

  return allowlist.length === 0 || matchesAllowlist(path, allowlist);
}

function matchesAllowlist(path, allowlist) {
  if (allowlist.length === 0) {
    return false;
  }

  return allowlist.some((entry) => {
    if (entry.endsWith('.*')) {
      const prefix = entry.slice(0, -2);
      return path === prefix || path.startsWith(`${prefix}.`);
    }

    return entry === path;
  });
}

function isSensitiveField(path) {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(path));
}

function redactValue(path, value) {
  if (/internal(Only)?Notes?|notesInternal|privateNotes?/i.test(path)) {
    return '[REDACTED: INTERNAL_NOTE]';
  }

  return sanitizeText(value)
    .replace(REDACTION_RULES.phone.pattern, `[REDACTED: ${REDACTION_RULES.phone.label}]`)
    .replace(REDACTION_RULES.payment.pattern, `[REDACTED: ${REDACTION_RULES.payment.label}]`)
    .replace(REDACTION_RULES.id.pattern, (match) => {
      if (/^(ticket|order)$/i.test(path.split('.').at(-1) || '')) {
        return match;
      }

      return `[REDACTED: ${REDACTION_RULES.id.label}]`;
    });
}

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function flattenObject(value, prefix = '') {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenObject(item, joinPath(prefix, String(index))));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => flattenObject(child, joinPath(prefix, key)));
  }

  return prefix ? [{ path: normalizePath(prefix), value }] : [];
}

function joinPath(prefix, key) {
  return prefix ? `${prefix}.${key}` : key;
}

function normalizePath(path) {
  return path.replace(/\[(\d+)\]/g, '.$1');
}
