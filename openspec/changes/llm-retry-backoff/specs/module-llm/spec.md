# Spec Delta

## MODIFIED Requirements

### Requirement: Failures are typed

Every rejection from `ctx.llm.generate` SHALL be an error whose `kind` is one of:
- `unavailable`: the model can't be reached, is rate-limited, errors on the provider side, the key is not configured, or the call timed out.
- `invalid_output`
- `blocked`: the provider refused the prompt, or stopped the response for safety or a similar reason. The error carries the provider's reason.
- `invalid_request`
- `cancelled`: the caller's signal was aborted.

Rate limits, provider-side errors and network errors SHALL be retried up to 2 times before rejecting with `unavailable`. Other kinds SHALL NOT be retried.

When a rate-limit response states how long to wait, the next attempt SHALL wait that long, and otherwise the delay SHALL increase per attempt. The wait SHALL be bounded by the request's `maxRetryWaitMs`, or by `FRIDAY_LLM_MAX_RETRY_WAIT_MS` (default 60000) when the request sets none. A rate limit whose stated wait exceeds that bound, or whose exhausted quota is a daily quota, SHALL NOT be retried: the call SHALL reject with `unavailable` at once, with a message stating the requested wait or the quota. Waiting SHALL end as soon as the caller's signal is aborted, with `cancelled`.

#### Scenario: Transient error
- **WHEN** the provider returns HTTP 503 once and then succeeds
- **THEN** the call resolves with the successful response

#### Scenario: Persistent outage
- **WHEN** the provider keeps returning HTTP 503
- **THEN** the call rejects with `unavailable` after 3 attempts in total

#### Scenario: Rate limit with a stated wait
- **WHEN** the provider answers HTTP 429 asking to retry after 37 seconds, and then succeeds
- **THEN** the second attempt starts about 37 seconds after the first failed, and the call resolves with the successful response

#### Scenario: Stated wait exceeds the bound
- **WHEN** the provider answers HTTP 429 asking to retry after 90 seconds and the bound is 60 seconds
- **THEN** the call rejects with `unavailable` without another attempt, and the message states the 90-second wait

#### Scenario: Daily quota exhausted
- **WHEN** the provider answers HTTP 429 naming an exhausted per-day quota
- **THEN** the call rejects with `unavailable` without another attempt, and the message names the daily quota

#### Scenario: Cancelled while waiting
- **WHEN** a call is waiting to retry after a rate limit and its signal is aborted
- **THEN** it rejects with `cancelled` immediately

#### Scenario: Blocked prompt
- **WHEN** the provider blocks the prompt for safety
- **THEN** the call rejects with `blocked` and the provider's reason, without retrying

#### Scenario: No key
- **WHEN** `GEMINI_API_KEY` is not set
- **THEN** calls reject with `unavailable` stating that the key is not configured

### Requirement: Usage is logged without content

Every call SHALL be logged once when it settles, with the calling module's id, the model, the input and output token counts, the latency, the outcome (`ok`, or the error kind), and, when attempts failed, the reason for each failed attempt: the HTTP status or `network`, and the wait before the next attempt. Prompts, messages and responses SHALL NOT be logged.

#### Scenario: Log line
- **WHEN** module `brain` makes a successful call
- **THEN** one log line names `brain`, the model, the token counts, the duration, and `ok`, and contains none of the prompt text

#### Scenario: Retries are explained
- **WHEN** a call succeeds on its third attempt after a 429 with a 37-second wait and a 503
- **THEN** its log line records 3 attempts with the reasons `429` (with the 37-second wait) and `503`
