**Languages:** [English](index.md) · [Italiano](index.it.md)

# Contributor Guide

The contributor guide explains how to extend the discussion arena: adding
participants, writing examples that the production loaders accept, and
following the repository conventions. It is written for people who clone this
repository and modify its code or documentation.

## What this section covers

- Repository layout and documentation conventions (bilingual EN/IT pairs, `.it.md` suffix, cross links, link checker)
- Adding and overriding participant roles (`discoverParticipants`, project > user > bundled precedence)
- The coordination file (`.gsd/discussion-arena/discussion-arena-coordination.md`) with `rounds_default`, `model_default` and `roles_virtuals`
- Adding example files to `examples/` that are validated by the production loaders
- Testing conventions (`node:test`, the TS ESM loader, enforcement guards)

## When to read this

Read this guide when you want to contribute: you have cloned the repository,
you can run the test suite, and you want to add a role, an example or a
documentation page without breaking the conventions.

## Prerequisites

- Node 20+ and npm
- The repository cloned, with `npm install` and `npm run setup-types` completed
- Familiarity with Markdown and TypeScript

## Topics in this guide

The guide covers these pages:

- [Project layout](project-layout.md) — where source, tests, examples and docs live, and what the link checker enforces
- [Participants](participants.md) — frontmatter schema (`name`, `role`, `description`, optional `tools` and `model`), precedence rules, per-participant runtime limits
- [Coordination file](coordination-file.md) — schema, defaults, virtual roles, loader contracts and warnings
- [Examples](examples.md) — how an example becomes loadable by a production loader, and how `tests/examples-validation.test.ts` keeps it that way
- [Testing](testing.md) — running the suite, adding guards, avoiding regressions

> **Note on `docs/discussion-arena-deliberation-archive.md`:** that file is a
> local, unversioned deliberation transcript archive (D069). It is
> intentionally excluded from the documentation navigation — never link to it
> from guides or indexes.

## Related documentation

- [README](../../README.md) — overview, quickstart and limitations
- [User Guide](../user-guide/index.md) — installing and using the extension
- [Architecture Reference](../architecture/index.md) — how the discussion arena works internally

---

This index is the stable navigation contract: every page in this section
ships with its `.it.md` counterpart and cross links back here.
