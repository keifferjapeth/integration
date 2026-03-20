import test from 'node:test';
import assert from 'node:assert/strict';

import { buildContextPrompt } from '../src/contextBuilder.js';

test('builds a prompt from the requested context sources', () => {
  const result = buildContextPrompt({
    currentUserMessage: 'Customer says the replacement has not arrived.',
    conversation: [
      { id: 'm1', source: 'email', content: 'Original inbound' },
      { id: 'm2', source: 'bot.space', createdAt: '2026-03-19T10:00:00Z', content: 'Asked for the order number.' },
      { id: 'm3', source: 'bot.space', createdAt: '2026-03-19T10:05:00Z', content: 'Confirmed the shipping delay.' },
    ],
    crm: {
      customer: {
        firstName: 'Alex',
        tier: 'gold',
      },
    },
    crmFieldAllowlist: ['customer.firstName', 'customer.tier'],
    ticketSummary: 'Ticket T-100 is open for late delivery.',
    orderSummary: 'Order 4001 shipped 5 days ago.',
    businessRules: 'Offer expedited replacement after carrier investigation.',
    escalationPolicy: 'Escalate if the package is missing for more than 7 days.',
  });

  assert.match(result.prompt, /## Current user message\nCustomer says the replacement has not arrived\./);
  assert.match(result.prompt, /## Recent bot.space messages\n1\. \[2026-03-19T10:00:00Z\] Asked for the order number\./);
  assert.match(result.prompt, /- customer.firstName: Alex/);
  assert.match(result.prompt, /- customer.tier: gold/);
  assert.deepEqual(result.metadata.includedCrmFieldPaths, ['customer.firstName', 'customer.tier']);
  assert.deepEqual(result.metadata.includedBotSpaceMessageIds, ['m2', 'm3']);
});

test('omits sensitive CRM fields unless they are allowlisted', () => {
  const result = buildContextPrompt({
    currentUserMessage: 'Need an update.',
    crm: {
      customer: {
        firstName: 'Alex',
        phone: '+1 (415) 555-0199',
        internalNotes: 'VIP customer requested executive callback.',
      },
    },
    crmFieldAllowlist: ['customer.firstName'],
  });

  assert.match(result.prompt, /- customer.firstName: Alex/);
  assert.doesNotMatch(result.prompt, /customer.phone/);
  assert.doesNotMatch(result.prompt, /internalNotes/);
  assert.deepEqual(result.metadata.omittedSensitiveCrmFieldPaths.sort(), ['customer.internalNotes', 'customer.phone']);
});

test('redacts supported sensitive content when an allowlisted field is included', () => {
  const result = buildContextPrompt({
    currentUserMessage: 'Please verify the account.',
    crm: {
      customer: {
        phone: '+1 (415) 555-0199',
        paymentCard: '4111 1111 1111 1111',
        governmentId: 'ABCD1234',
        internalNotes: 'Refund approved by finance director.',
      },
    },
    crmFieldAllowlist: [
      'customer.phone',
      'customer.paymentCard',
      'customer.governmentId',
      'customer.internalNotes',
    ],
  });

  assert.match(result.prompt, /- customer.phone: \[REDACTED: PHONE\]/);
  assert.match(result.prompt, /- customer.paymentCard: \[REDACTED: PAYMENT\]/);
  assert.match(result.prompt, /- customer.governmentId: \[REDACTED: ID\]/);
  assert.match(result.prompt, /- customer.internalNotes: \[REDACTED: INTERNAL_NOTE\]/);
  assert.deepEqual(
    result.metadata.redactedCrmFieldPaths.sort(),
    ['customer.governmentId', 'customer.internalNotes', 'customer.paymentCard', 'customer.phone'],
  );
});

test('supports wildcard allowlists for nested CRM objects', () => {
  const result = buildContextPrompt({
    currentUserMessage: 'Need order details.',
    crm: {
      customer: {
        loyalty: {
          status: 'active',
          points: 1234,
        },
        phone: '415-555-0101',
      },
    },
    crmFieldAllowlist: ['customer.loyalty.*'],
  });

  assert.match(result.prompt, /customer.loyalty.status: active/);
  assert.match(result.prompt, /customer.loyalty.points: 1234/);
  assert.doesNotMatch(result.prompt, /customer.phone/);
});
