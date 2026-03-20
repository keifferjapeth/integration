# Integration Backend Instrumentation Plan

## Current blocker

This repository does not currently contain an integration backend implementation.
At the time of writing, the Git tree only includes an empty `.gitkeep` file, so there are no webhook handlers, CRM client modules, OpenAI client calls, logging setup, metrics registry, or persistence models available to instrument.

## Required implementation targets

When the backend code is added, implement the following cross-cutting observability features.

### 1. Correlation identifiers

Create and propagate the following identifiers through every request, async job, log line, metric label, and audit record:

- `request_id`: generated per inbound HTTP request or message-consumption event.
- `conversation_id`: required on all webhook processing, CRM sync, and OpenAI recommendation flows.
- `botspace_user_id`: extracted from inbound payloads and added to structured logging context.
- `crm_contact_id`: extracted or resolved before any CRM read/write and added to structured logging context.

Recommended propagation rules:

- Accept external `x-request-id` if present; otherwise generate a UUID.
- Store IDs in request-scoped context so nested services inherit them automatically.
- Return `x-request-id` in API responses.
- Require every queue message or internal event to include `request_id` and `conversation_id`.

### 2. Structured logs

Emit JSON logs only.

#### Webhook receive log

Emit one event when the webhook request is accepted:

- `event_name`: `webhook.received`
- `request_id`
- `conversation_id`
- `botspace_user_id`
- `crm_contact_id` if known
- `provider`
- `endpoint`
- `http_method`
- `payload_size_bytes`
- `received_at`

#### Webhook send log

Emit one event for every outbound webhook or callback:

- `event_name`: `webhook.sent`
- `request_id`
- `conversation_id`
- `botspace_user_id`
- `crm_contact_id`
- `provider`
- `target_url`
- `status_code`
- `duration_ms`
- `response_size_bytes`
- `sent_at`
- `error_code` and `error_message` on failure

#### Searchability requirements

The logging backend must index these fields explicitly:

- `botspace_user_id`
- `crm_contact_id`
- `conversation_id`
- `request_id`

### 3. CRM metrics

Add metrics for all CRM API traffic.

#### Latency

Histogram:

- `crm_api_latency_ms`
- labels: `operation`, `provider`, `status`

#### Errors

Counter:

- `crm_api_errors_total`
- labels: `operation`, `provider`, `error_type`, `retryable`

### 4. OpenAI metrics

Add metrics around all OpenAI requests.

#### Latency

Histogram:

- `openai_request_latency_ms`
- labels: `model`, `operation`, `status`

#### Token usage

Counters:

- `openai_tokens_prompt_total`
- `openai_tokens_completion_total`
- `openai_tokens_total`
- labels: `model`, `operation`

#### Failures

Counter:

- `openai_request_failures_total`
- labels: `model`, `operation`, `error_type`, `retryable`

### 5. Audit records

Persist immutable audit rows for every AI recommendation and every CRM mutation.

#### AI recommendation audit record

Store:

- `audit_id`
- `request_id`
- `conversation_id`
- `botspace_user_id`
- `crm_contact_id`
- `actor_type`: `ai`
- `action`: `recommendation_created`
- `model`
- `prompt_template_version`
- `input_summary`
- `output_summary`
- `token_usage_prompt`
- `token_usage_completion`
- `created_at`

#### CRM mutation audit record

Store:

- `audit_id`
- `request_id`
- `conversation_id`
- `botspace_user_id`
- `crm_contact_id`
- `actor_type`: `system` or `user`
- `action`: operation such as `contact_updated`, `note_created`, `deal_updated`
- `crm_provider`
- `mutation_before`
- `mutation_after`
- `status`
- `error_details` if applicable
- `created_at`

## Suggested implementation sequence

1. Add request-context middleware for `request_id` and `conversation_id`.
2. Upgrade logger configuration to inject request context into every JSON log event.
3. Wrap inbound and outbound webhook handlers with structured logging helpers.
4. Wrap CRM client methods with latency/error metrics and audit hooks.
5. Wrap OpenAI client methods with latency, token, and failure metrics plus recommendation auditing.
6. Backfill dashboards and saved searches keyed by `botspace_user_id`, `crm_contact_id`, and `conversation_id`.

## Acceptance criteria

The backend implementation should not be considered complete until:

- Every inbound request has a `request_id` and a `conversation_id`.
- Every webhook receive/send action emits a searchable JSON log event.
- Every CRM API call records latency and error metrics.
- Every OpenAI call records latency, token usage, and failure metrics.
- Every AI recommendation and CRM mutation persists an immutable audit record.
- Logs can be filtered directly by `botspace_user_id`, `crm_contact_id`, and `conversation_id`.
