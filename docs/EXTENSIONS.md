# Code Foundry extension points

Code Foundry uses an overlay model: `sync` refreshes the documented baseline while
repository-owned behavior stays in separate files.

## Managed files

The standard workflows, hooks, governance documents, language configuration, and
release configuration are refreshed from the configured runtime. Keep
repository-specific behavior outside those managed paths.

## Custom workflows

Any workflow not named by the baseline is preserved automatically. This is the
supported place for project-specific workflows such as Slither, search indexing,
deployment, Docker publishing, or Vercel tasks.

`custom_workflows: preserve` is the default and the only supported value. Code
Foundry intentionally has no prune mode for custom workflows; remove those files
explicitly when they are no longer needed.

## Post-release delivery

Use `post_release`, `post_release_workflow`, and `post_release_mode` for a
post-release artifact workflow:

```yaml
post_release: true
post_release_workflow: deploy.yml
post_release_mode: auto
```

`auto` uses a single workflow dispatch when `CODE_FOUNDRY_TOKEN` is available;
otherwise it uses the published-release event when that path is enabled. The
workflow receives `release-tag` and a deterministic `delivery-key`. Delivery is
at most once per tag, so retries must be explicit and idempotent.

Keep deployment credentials, environment files, and project-specific secrets in
repository or organization configuration. Code Foundry never copies secret
values or overwrites custom workflows in overlay mode.
