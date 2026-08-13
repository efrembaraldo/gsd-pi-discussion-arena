**Languages:** [English](install.md) · [Italiano](install.it.md)

[User Guide](index.md) — Installation

# Installing the discussion arena extension

The discussion arena is a gsd-pi extension: it registers the `discussion_arena`
tool and the `/discussion-arena` command, and ships four bundled participants
(`analyst`, `architect`, `dev`, `qa`). This page covers the three installation
paths (npm, interactive session, manual copy), what *scope* means for an
installation, how to verify that the extension is actually loaded, and how to
remove it.

The [README](../../README.md) covers the same ground up to the first round.
This page adds what the README leaves out: the user-vs-project distinction,
post-install verification and removal. The commands below are anchored to the
gsd-pi package manager (`packages/pi-coding-agent/src/core/package-commands.ts`
and `package-manager.ts`) and to the extension commands implemented in
`commands-extensions.js` — not to a description of them.

## Prerequisites

- gsd-pi installed and on your `PATH` — check with:

```bash
gsd --version
```

- Node.js and npm (used by `gsd install` to fetch npm packages)

## Method 1 — install from npm (recommended)

```bash
gsd install npm:@efrembaraldo/gsd-pi-discussion-arena
```

`gsd install` is a top-level CLI command (the same family as `gsd remove`,
`gsd list` and `gsd update`). It does three things:

1. installs the package with npm into the user-scope npm root
   (`~/.gsd/agent/npm/node_modules/`);
2. registers the source in the user settings file
   (`~/.gsd/agent/settings.json`);
3. runs the extension lifecycle hooks, if any.

Then restart gsd-pi, or run `/reload` in an interactive session: extensions
are discovered at session start.

To pin a specific version, append it to the package name:

```bash
gsd install npm:@efrembaraldo/gsd-pi-discussion-arena@0.7.2
```

To update later: `gsd update npm:@efrembaraldo/gsd-pi-discussion-arena`
(without a source, `gsd update` updates every configured package).

## Method 2 — install from an interactive session

Inside a running gsd-pi session, the `/gsd extensions` command family manages
the extension registry. Install with:

```text
/gsd extensions install @efrembaraldo/gsd-pi-discussion-arena
```

This packs the package with npm, validates the manifest, extracts it into
`~/.gsd/agent/extensions/gsd-pi-discussion-arena/` and records a registry
entry in `~/.gsd/extensions/registry.json`. The command then prints
"Restart GSD to activate." — restart before using the tool.

The same command accepts git URLs and local paths:
`/gsd extensions install git:github.com/user/repo` or
`/gsd extensions install ./local/path`. The family has `install`, `list`,
`info`, `enable`, `disable` and `validate` — there is no `remove`
subcommand (see [Removing the extension](#removing-the-extension)).

## Method 3 — manual copy (no npm)

For local testing, offline machines or a development checkout, copy the
extension files directly into the user extensions directory:

```bash
mkdir -p ~/.gsd/agent/extensions/gsd-pi-discussion-arena
cp -r index.ts participants.ts run-participant.ts package.json extension-manifest.json ~/.gsd/agent/extensions/gsd-pi-discussion-arena/

mkdir -p ~/.gsd/agent/discussion-arena/participants
cp participants/*.md ~/.gsd/agent/discussion-arena/participants/
```

The minimum file set is the entry file (`index.ts`), the manifest
(`extension-manifest.json`, which declares the `discussion_arena` tool and the
`discussion-arena` command) and the runtime modules they import. The second
copy gives you the four bundled examples as *user* participants, so they win
over the bundled ones (see the scope section below). Restart gsd-pi
afterwards.

## User scope vs project scope

"Scope" has two independent meanings for this extension; do not confuse them.

### 1. Where the extension code lives

`gsd install` defaults to the **user** scope. The `-l` / `--local` flag
installs into the **project** scope instead. The two scopes keep separate
settings files and npm roots:

| | User scope (default) | Project scope (`-l`) |
| --- | --- | --- |
| Settings file | `~/.gsd/agent/settings.json` | `<cwd>/.gsd/settings.json` |
| npm install root | `~/.gsd/agent/npm/` | `<cwd>/.gsd/npm/` |
| Affects | every project of this user | only this project |

`gsd list` shows the configured packages of both scopes together, with the
resolved install path:

```text
User packages:
  npm:@efrembaraldo/gsd-pi-discussion-arena
    /home/you/.gsd/agent/npm/node_modules/@efrembaraldo/gsd-pi-discussion-arena
```

Packages from both scopes are resolved, so an installation in either scope
makes the tool available. In practice the extension code is almost always
installed at user scope: the per-project part of the discussion arena is the
participants (see below).

### 2. Where participants come from

At runtime the extension resolves participants with this precedence (highest
wins, `participants.ts`):

| Tier | Directory | Notes |
| --- | --- | --- |
| Project | `.gsd/discussion-arena/participants/` | walk-up from the working directory: the nearest existing directory wins |
| User | `~/.gsd/agent/discussion-arena/participants/` | shared by all projects of the user |
| Bundled | `participants/` next to the installed module | the four examples, always present after install |

(Two advanced tiers — overrides and the coordination document — exist above
the project tier; they are documented in the
[Contributor Guide](../contributor-guide/index.md).)

A participant is a markdown file with YAML frontmatter:

```markdown
---
name: analyst
role: Business Analyst
description: Chiarisce requisiti, obiettivi di business e vincoli prima che si discuta di soluzioni tecniche
tools: read, grep, find, ls
model: freeinference_efrem/minimax-m3
---
```

The `name` is the identity used for the precedence: a participant copied to
project scope with the same `name` replaces the user/bundled one in that
project. The four bundled participants are always available after install;
copy them where you want to customize them instead of editing the module copy
(an update of the extension would overwrite it).

## Verifying the installation

Three checks, in increasing order of confidence:

1. **The package is configured.** `gsd list` shows the source with its
   install path (sample above). Missing → the source was never registered,
   or it was removed.

2. **The manifest was read.** In an interactive session:

```text
/gsd extensions info gsd-pi-discussion-arena
```

prints the manifest fields, the registry status and the `provides` block:

```text
gsd-pi-discussion-arena (gsd-pi-discussion-arena)

  Version:     0.1.0
  Description: Agent Discussion Arena per gsd-pi: consiglio di agenti con ruoli/competenze configurabili, coordinato dal ciclo auto di gsd-pi
  Tier:        community
  Status:      enabled
  Provides:
    Tools:     discussion_arena
    Commands:  discussion-arena
```

`Extension "gsd-pi-discussion-arena" not found` → the manifest is not
discoverable: wrong directory name, missing `extension-manifest.json`, or no
restart yet.

1. **The tool is registered.** In print mode, ask for the tool list:

```bash
gsd -p "list the available tools" --mode json | grep discussion_arena
```

A match for `discussion_arena` → the extension loaded and registered its
tool. No match → the extension failed to load; extension load errors are
printed at session startup (they appear as `[gsd]` warnings on stderr).

## Removing the extension

- **Installed via `gsd install npm:`** — remove with the same command
  family:

```bash
gsd remove npm:@efrembaraldo/gsd-pi-discussion-arena
```

`gsd remove` uninstalls the package from the scope's npm root and drops the
source from `settings.json`. Use `-l` when the package was installed with
`-l`. Participant files you copied by hand are NOT touched by `gsd remove`:
delete them separately (below).

- **Installed via `/gsd extensions install` or manual copy** — the slash
  family has no `remove` subcommand, so removal is manual:

```bash
rm -rf ~/.gsd/agent/extensions/gsd-pi-discussion-arena
rm -rf ~/.gsd/agent/discussion-arena/participants   # only if you copied participants there
```

and, if present, drop the matching entry from
`~/.gsd/extensions/registry.json`. For a project-scope manual install,
remove the same files under `<cwd>/.gsd/` instead.

Removing the extension code also removes its bundled participants with it:
after a full removal no participant is discovered and the `discussion_arena`
tool is no longer registered at the next session start. To confirm, re-run
the verification checks: `gsd list` no longer shows the source and the
`grep discussion_arena` command produces no match.

## Related documentation

- [User Guide](index.md) — quickstart, configuration, usage, troubleshooting
- [README](../../README.md) — overview, quickstart and known limitations
- [Contributor Guide](../contributor-guide/index.md) — roles, participants and repository conventions
- [Architecture Reference](../architecture/index.md) — how participants are discovered and run
