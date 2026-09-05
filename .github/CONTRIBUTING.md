# Contributing

This guide is the operating contract for humans and automation contributing to this repository.

It applies to TypeScript, Rust, Python, and mixed-language projects using this template.

Quick links: [Code of Conduct](./CODE_OF_CONDUCT.md) · [Security Policy](./SECURITY.md) · [Pull Request Template](./PULL_REQUEST_TEMPLATE.md)

### Contents

[Agent contract](#agent-operating-contract) · [Branches](#branching-model) · [Setup](#before-you-start) · [Validation](#local-validation) · [Internal](#internal-contribution-workflow) · [External](#external-contribution-workflow) · [Pull requests](#pull-request-standards) · [Reviews](#review-and-merge-protocol) · [Security](#security-and-emergencies)

## Agent operating contract

Agents must follow these rules before changing code:

1. Read this file, `AGENTS.md`, and the relevant project documentation.
2. Inspect the current branch, worktree, remotes, and existing changes before editing.
3. Preserve user-owned changes. Never discard or overwrite unrelated work.
4. Branch from `main` and target pull requests at `main`; do not push directly to `main`.
5. Keep the change focused. Do not expand scope without documenting why.
6. Run the applicable format, lint, type-check, build, unit, integration, E2E, smoke, and security checks.
7. Report exact validation results, skipped checks, known limitations, and remaining risks.
8. Never commit secrets, credentials, local environment files, generated artifacts, or machine-specific paths.

Agents must not:

- Use destructive Git operations, force pushes, or history rewriting without explicit authorization.
- Bypass hooks or required checks to hide a failure.
- Change branch protections, secrets, deployments, or external systems unless that action is explicitly in scope.
- Claim completion when tests, deployment checks, or required reviews are still pending.

## Branching model

```text
                              release PR
                           ┌──────────────┐
                           │              ▼
feat/*  fix/*  chore/*  ──PR──▶  main
docs/*  test/*  refactor/*         │
                                   └── protected release branch
```

| Branch                                                         | Purpose                  | Contribution rule                                      |
| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| `main`                                                         | Protected release branch | Merge through pull requests only. No direct pushes.    |
| `feat/*`, `fix/*`, `chore/*`, `refactor/*`, `docs/*`, `test/*` | Focused work             | Branch from `main`; keep changes small and reviewable. |

The Git workflow is `direct`: topic branches **squash** directly into `main`, and the Release Please version PR **rebases** into `main` (`release_merge_strategy: rebase`). Release automation never defaults to a merge method and never merges with `--admin`; `code-foundry doctor` and `code-foundry sync` fail closed on any other release merge strategy. Feature branches never touch `staging`; repositories with a preview/staging environment opt into `git_workflow: staging-release` explicitly.

## Before you start

### Toolchain

1. Run `npx code-foundry init` to detect the repository and enable hooks.
2. Follow `toolchain: auto` in `.github/code-foundry.yml`; install mise only if the repository already uses it or explicitly selects it.
3. Use `npx code-foundry doctor` when setup, lockfiles, or hooks appear out of sync.
4. Use the repository's existing package manager and lockfile. Do not introduce a second package manager.
5. Copy `.env.example` to the appropriate local environment file when provided. Never commit the copy.

### Worktree and branch

```sh
git status --short --branch
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c feat/short-description
```

If the worktree is dirty, stop and understand the existing changes before switching branches or editing overlapping files.

## Local validation

The repository runtime detects supported tools and skips checks that do not apply:

```sh
npx code-foundry doctor
npm run format:check   # or the package manager's equivalent
npm run lint
npm run type-check
npm test
Security and dependency audits run through the GitHub Security workflow.
```

Run the checks relevant to the change. For a release or security-sensitive change, run the complete set. Record the commands and results in the pull request.

## Internal contribution workflow

For maintainers, trusted contributors, and automation agents:

1. Start from an up-to-date `main` branch.
2. Create a focused branch with a descriptive prefix.
3. Inspect the relevant code and tests before making changes.
4. Implement the smallest complete change.
5. Add or update tests, documentation, configuration, and migration notes as needed.
6. Run local validation and inspect the final diff.
7. Commit with a clear message, preferably using Conventional Commits:

   ```text
   feat(auth): add passkey recovery
   fix(api): handle expired session tokens
   chore(ci): cache Rust dependencies
   ```

8. Push the branch and open a pull request into `main`.
9. Address review feedback and failed checks on the same branch.
10. Merge with a squash after required checks pass and the change is ready; feature PRs land on `main` with squash merges.

### Internal agent handoff

Every agent handoff should state:

```text
Summary: what changed and why
Files: important files changed
Validation: exact commands and pass/fail results
Skipped: checks skipped and why
Risks: known limitations or follow-up work
Branch/PR: branch name and pull request link
```

## External contribution workflow

For contributors who do not have direct write access:

1. Fork the repository on GitHub.
2. Add the upstream repository as `upstream`.
3. Branch from the upstream `main` branch.
4. Make a focused change and follow the local setup instructions.
5. Add tests and documentation for behavior changes.
6. Run all applicable checks locally.
7. Push to the fork and open a pull request targeting `main`.
8. Explain the problem, proposed solution, validation, compatibility, and rollout impact.
9. Address maintainer feedback without rewriting unrelated history or scope.

External contributors should never need repository secrets or production access to validate a normal change.

## Pull request standards

Every pull request should make these questions easy to answer:

- What changed?
- Why was it needed?
- How was it tested?
- What could break?
- Does it require migration, deployment, configuration, or rollback work?
- Which files or areas deserve focused review?

Keep pull requests focused and reviewable. Include screenshots or recordings for user-facing changes. Link related issues and use `Closes #123` when appropriate. Complete the [pull request template](./PULL_REQUEST_TEMPLATE.md).

## Workflow and check behavior

| Event | Expected automation |
|------------------------------------------------------------------------------------------------------------------------------------------------|
| Pull request targeting `main` | Audit validation: CI, full tests, Security, and CodeQL, ending in `Validation / Gate` |
| Exact Release Please pull request targeting `main` | Release-policy validation only, ending in `Validation / Gate` |
| Scheduled or manual validation | Full audit tier |
| Push to a working branch | Draft PR workflow |
| Push to `main` | Release workflow; canonical validation already ran on the merged PR |
The single validation caller keys concurrency by event and pull-request head. A newer update to the same pull request cancels its superseded validation run; scheduled and manual audits remain independent. The mode-aware orchestrator fans out only the jobs required by that event and always concludes with the stable aggregate gate.

Required checks are enforced by branch protection rulesets/branch protection. Do not duplicate their checklists in the pull request description; document validation commands and results instead.

### Release conventions

Use Conventional Commits so the release automation can determine the next version: `fix:` produces a patch release, `feat:` produces a minor release, and `!` or `BREAKING CHANGE:` produces a major release. Add `Release-As: x.y.z` only when a deliberate version override is needed. The release workflow maintains the changelog and GitHub release after changes land on `main`; npm publication is opt-in through `.github/code-foundry.yml`.

Security checks can be skipped when repository visibility or the GitHub plan does not support a feature. A skipped optional check must not be configured as a required status check.

## Review and merge protocol

| Change | Target | Merge method | Merge gate |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Working branch | `main` | Squash | All applicable required checks pass |
| Release Please version PR | `main` | Rebase (`release_merge_strategy`, fails closed) | Validation gate and release policy pass |
Reviewers focus on correctness, security, maintainability, test coverage, operational impact, and compatibility. Authors remain responsible for responding to feedback and verifying the final commit.

## Security and emergencies

Report vulnerabilities privately using [SECURITY.md](./SECURITY.md), never in a public issue or pull request.

For an urgent production or security issue:

1. Create a focused branch from `main`.
2. Document the urgency and affected systems without exposing secrets.
3. Open a pull request and run the narrowest complete validation available.
4. Request the appropriate maintainer review.
5. Record follow-up work, remediation, and rollback information.

CI bypasses are for documented infrastructure emergencies only and require a follow-up fix. Never use a bypass to hide a code or test failure.
