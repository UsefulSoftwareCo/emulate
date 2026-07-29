# Product direction

Emulate is a stateful integration simulator for real developer APIs. It lets
humans and agents stand up service-shaped environments, authenticate, exercise
flows, inspect calls and side effects, and reset or replay scenarios. It is not
a generic mock server.

## Fidelity

Model what a real provider exposes, not every protocol the platform can
technically host. GitHub can legitimately include REST, GraphQL, OAuth,
GitHub App authentication, webhooks, and a deliberate MCP surface. A provider
without GraphQL or MCP should not acquire those surfaces merely for symmetry.

Specifications are inputs rather than the complete product. OpenAPI, GraphQL
schemas, MCP manifests, discovery documents, OAuth metadata, and hand-authored
behavior packs may each contribute. Honest curated coverage is better than a
broad emulator that quietly invents unsupported semantics.

## Service manifest

Each service should expose a machine-readable manifest describing:

- identity and purpose
- supported protocols and provider-specific behavior
- source specifications and coverage status
- authentication and credential capabilities
- seed schema, scenarios, reset behavior, and state model
- inspector and request-ledger capabilities
- copyable connection details for SDKs, CLIs, agents, and applications

Hosted emulators must be understandable without repository context. A visitor
should be able to create or select an instance, issue credentials, seed state,
find endpoints, inspect calls, and copy connection examples.

## Routing and control plane

Prefer service and instance hosts such as `github.emulators.dev` and
`github.my-test-run.emulators.dev`. Provider traffic must remain faithful to the
real service. Emulate controls belong under the reserved `/_emulate` namespace.

The common control plane should converge on discoverable manifest, quickstart,
specification, instance, seed, reset, credential, state, ledger, and log routes.

## Ledger and behavior

The request ledger is a core contract. Record enough sanitized information for
tests and people to understand the request, authenticated identity, matched
operation, response, side effects, webhook deliveries, timing, and correlation.

OpenAPI generation provides route skeletons, validators, baseline responses,
documentation, and coverage reporting. Hand-authored behavior overrides it for
stateful workflows, authentication, provider-specific semantics, webhooks, and
important edge cases.

Optimize decisions for deployed application testing, local automated tests,
human-readable inspectors, agent-readable manifests, faithful credentials,
honest support boundaries, and shared definitions across hosted and in-process
surfaces.
