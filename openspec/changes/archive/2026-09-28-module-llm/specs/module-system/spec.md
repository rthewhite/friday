# Spec Delta

## ADDED Requirements

### Requirement: Text model in the context

`ModuleContext` SHALL include `llm` as specified in `module-llm`. Calls SHALL be attributed to the module id in usage logging. The error type and its kinds SHALL be exported from `@friday/sdk`, so modules can branch on `kind` without depending on core.

#### Scenario: Branch on the error kind
- **WHEN** a module catches a rejection from `ctx.llm.generate`
- **THEN** it can test the error with the SDK's exported type and read its `kind`

### Requirement: Test host fakes the text model

`createTestHost` SHALL accept an `llm` option: a function that receives each request and returns the model's raw text, or throws an SDK LLM error. The test host SHALL apply the same request checks and schema validation as core, so a fake answer that does not conform to the schema rejects with `invalid_output`. It SHALL record the requests it received. Without the option, `ctx.llm.generate` SHALL reject with `unavailable`.

#### Scenario: Fake answer is validated
- **WHEN** a test's fake returns `{"fact":"x"}` for a request whose schema requires `facts`
- **THEN** the module's call rejects with `invalid_output`, as it would against the real model

#### Scenario: Requests are observable
- **WHEN** a module under test makes two calls
- **THEN** the test host exposes both requests, including their system instruction and schema

#### Scenario: No fake configured
- **WHEN** a test host is created without `llm` and the module calls `ctx.llm.generate`
- **THEN** the call rejects with `unavailable`
