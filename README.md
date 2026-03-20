# CRM AI Action Authorization

This repository contains a minimal server-side authorization layer for CRM actions triggered by AI recommendations.

## What it does

- Allowlists low-risk AI actions such as creating notes, leads, and support tickets.
- Allows updates only to a limited set of non-critical fields.
- Blocks or requires manual approval for sensitive operations such as deleting records, changing pipeline stage, reassigning ownership, and updating billing or contract data.
- Logs the original AI recommendation separately from the final permitted action decision.

## Example

```js
import {
  authorizeAiCrmAction,
  InMemoryAiActionLogger,
} from './src/index.js';

const logger = new InMemoryAiActionLogger();

const decision = authorizeAiCrmAction(
  {
    recommendationId: 'rec-42',
    actor: 'ai-agent',
    action: 'update_record',
    target: { type: 'lead', id: 'lead-42' },
    payload: { firstName: 'Jordan', notes: 'Asked for a pricing sheet.' },
  },
  { logger },
);

console.log(decision);
console.log(logger.entries);
```
