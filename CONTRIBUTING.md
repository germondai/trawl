# Contributing to TRAWL

Thanks for your interest in contributing! TRAWL is a self-hosted web scraping engine released under [AGPL-3.0](LICENSE). By submitting a contribution, you agree to license your work under the same terms.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful, assume good faith, and focus on the technical merits.

## Reporting bugs & requesting features

Please use the GitHub issue templates — they ensure we have the context we need:

- **Bug reports:** [`.github/ISSUE_TEMPLATE/bug_report.md`](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests:** [`.github/ISSUE_TEMPLATE/feature_request.md`](.github/ISSUE_TEMPLATE/feature_request.md)

For security issues, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: **Bun ≥ 1.1** and **Docker** (for the Dragonfly service used in tests).

```bash
git clone https://github.com/germondai/trawl.git
cd trawl
bun install
cp .env.example .env
```

### Running the apps

```bash
bun run dev:api     # Elysia API on :8191
bun run dev:web     # Nuxt 4 landing page
bun run dev:docs    # VitePress docs site
```

The API requires Dragonfly (Redis-protocol compatible). The fastest way is `docker compose up -d dragonfly`.

### Linting & formatting

We use [Biome](https://biomejs.dev/) for both:

```bash
bun run lint        # check
bun run format      # write
bun run check       # format + lint + import sort, write
```

CI runs `bun run lint` on every PR.

## Project layout

This is a Bun monorepo with workspaces:

```
apps/
  api/      Elysia API (the scraper service)
  web/      Nuxt 4 landing page
  docs/     VitePress documentation
packages/
  browser/  Camoufox Firefox pool
  tiers/    Tier 1–4 execution engine
  types/    Shared TypeScript types
```

Apps are independently deployable; `packages/*` are imported via the workspace protocol (e.g. `workspace:*`).

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Recent examples:

```
ci(publish): build images for linux/amd64, linux/arm64, linux/arm/v7
chore: add .gitignore files for api, docs, web, and browser packages
fix(browser): restore pool after worker crash
```

The `type` is one of `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`, `perf`. Keep the subject under 72 chars and in the imperative mood.

## Pull request process

1. **Open an issue first** for non-trivial changes. A two-paragraph problem statement is enough.
2. **Branch from `main`.** Use a descriptive name (`feat/captcha-hcaptcha`, `fix/redis-reconnect`).
3. **Run `bun run check` before pushing.** Lint and format must be clean.
4. **Update `CHANGELOG.md`** under `## [Unreleased]` for any user-visible change.
5. **Fill out the PR template** — the checklist catches the easy-to-miss items.
6. **Keep PRs focused.** One feature or fix per PR; large refactors should be split.

## Adding a new tier or solver

TRAWL's design centers on a 4-tier escalation ladder (HTTP → cached session → fresh CF solve → residential proxy). If your contribution introduces a new tier or a new solver:

- Put tier logic in `packages/tiers/`.
- Put browser/solver adapters in `packages/browser/`.
- Update the tier diagram in `README.md`.
- Add an entry to `CHANGELOG.md`.

## License

TRAWL is licensed under **AGPL-3.0**. By submitting a pull request, you affirm that your contribution is your own work and you agree to license it under AGPL-3.0. AGPL is more restrictive than MIT/Apache — if your employer might claim ownership of your work, get explicit approval first.