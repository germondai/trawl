---
name: Feature request
about: Propose a new TRAWL feature
title: "[feat] "
labels: enhancement
assignees: ''
---

## Problem

What are you trying to do that TRAWL doesn't support today? What's the use case?

## Proposed solution

How would you like this to work? Be specific — request shape, response shape, env vars, config keys.

## Alternatives considered

What other approaches did you consider, and why isn't one of them good enough already?

## Tier impact

TRAWL has a 4-tier escalation ladder (HTTP → cached session → fresh CF solve → residential proxy). Does your feature:

- [ ] Fit inside an existing tier?
- [ ] Require a new tier or solver?
- [ ] Apply cross-cutting (caching, observability, config)?

If you checked the second box, mention which tier slot it would occupy and roughly where in `packages/tiers/` it would live.

## Willingness to contribute

- [ ] I'd like to implement this myself and open a PR
- [ ] I'd be happy with a maintainer implementing it
- [ ] Just a discussion for now

## Additional context

Screenshots, examples from other tools, references — anything that helps frame the proposal.
