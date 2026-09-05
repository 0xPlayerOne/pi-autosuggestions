# Code Foundry extension points

Code Foundry uses an overlay model. The files in its documented baseline are managed by `sync`; repository-owned files outside that baseline remain yours.

## Managed files

The standard workflows, hooks, governance documents, language configuration, and release configuration are refreshed from the configured runtime. Keep repository-specific behavior in separate files.

## Custom workflows

Any workflow not named by the baseline is preserved automatically. This is the supported place for project-specific workflows such as Slither, search indexing, deployment, Docker publishing, or Vercel tasks.

Set `custom_workflows: preserve` in `.github/code-foundry.yml` (the default). Code Foundry intentionally has no prune mode for custom workflows; remove those files explicitly when they are no longer needed.

## Release and deployment hooks

Use `post_release`, `post_release_workflow`, and `post_release_mode` for a post-release artifact workflow. The hook receives `release-tag` and `delivery-key` inputs and is dispatched at most once per tag when a release token is available.

Keep deployment credentials, environment files, and project-specific secrets in the repository or organization configuration. Code Foundry never copies secret values or overwrites custom workflows in overlay mode.
