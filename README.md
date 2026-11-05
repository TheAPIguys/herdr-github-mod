# Herdr GitHub mod

Personal GitHub panel and issue-agent mods for the native **Herdr desktop app**.
This is not the separate `git-d-herdr` terminal dashboard.

## Features

- Open issues and pull requests, search, label filters, and sorting.
- Milestone filter: all milestones, one named milestone, or no milestone.
  Closed milestones are available too; lists show **open** issues/PRs only.
- Wider 780 × 680 popup and larger, wrapping titles.
- Click an issue to read its full formatted description and discussion inside the mod.
- Follow linked issues (including closed and cross-repository issues), then use Back
  or Issues list to return without resetting list filters. Other links open the browser.
- Start an installed coding agent in a Git worktree, selecting its model.
- Minimal initial prompt: issue number/title, `gh issue view`, and branch name.
- Existing PR CI badge/check notifications.

Lists currently return up to 50 results per tab, filtered on GitHub first.
"No milestone" means unassigned items, not all items. Select the **Issues**
tab to view issues; **PRs** displays pull requests.

## Reading issues

Click an issue row to open a GitHub-like reader with its title, Open/Closed
status, author, milestone, labels, formatted description and comments. GitHub
renders the Markdown through its authenticated API, and Herdr displays it
natively (not in a web browser). Task checkboxes are read-only text markers.
An amber **Blocked · N** badge beside Open shows unresolved dependencies from
GitHub's native "blocked by" relationships. Closed blockers do not contribute;
mentions such as "Depends on #123" in prose alone do not create a dependency.

Issue references such as `#123` and full issue links navigate within the reader,
including closed issues and other repositories on the same GitHub host.
**Back** retraces linked issues; **Issues list** returns directly to the filtered
list. PR links and other external HTTPS links open the system browser.
Use **Refresh** to reload the discussion; recent issues are cached in memory
for one minute. No issue descriptions or comments are saved to this repository.

**Start agent** is available only in the original repository, to avoid creating
a worktree in the wrong checkout when following cross-repository links.
This is a read-only reader, not an issue editor. Styling follows Herdr's native
renderer: it is not a pixel-identical GitHub page, rich issue-title previews
are not fetched, and some images/GitHub-specific formatting may require
**Open in GitHub**. Same-page heading/comment anchors do not scroll to a target yet.

## Install on another Linux computer

Requires the native Herdr app with mod support, Git, GitHub CLI (`gh`), and
an installed coding agent for the optional Agent button. `rsync` is needed
when copying files selected by a repository's `.worktreeinclude`.
Browser links currently use Linux's `xdg-open`.

```bash
gh auth login
git clone https://github.com/TheAPIguys/herdr-github-mod.git
cd herdr-github-mod
bash install.sh
```

The installer validates both mods and links them into
`~/.config/herdr-app/mods/`. Existing `github` and `issue-agent` folders are
**backed up**, never deleted. Keep the cloned repository in place: the links
make it the live source. `HERDR_APP_HOME` or `XDG_CONFIG_HOME` can override
the default config location.

Reopen the panel, or restart Herdr if necessary. From a terminal:

```bash
herdr-app do mod.open '{"name":"github"}'
```

Select a space whose terminal is inside a Git repository with a GitHub remote.
If you want the existing shortcut on a new computer, add
`"ctrl-shift-g": "mod.open:github"` to the `global` object in Herdr's
`keys.json`, without replacing other settings or existing bindings.
The installer does not change your layout, shortcuts, or personal settings.

## Update another computer

```bash
cd /path/to/herdr-github-mod
git pull --ff-only
bash install.sh
```

Commit or otherwise preserve any local edits before pulling. Reopen the
panel/restart Herdr if changes do not appear automatically.

## Save future changes

Edit the files under this checkout's `mods/` directory. Because Herdr's mod
folders link here, the same edits are used by the app and tracked by Git.
Changes are **not uploaded automatically**:

```bash
herdr-app check mods/github
herdr-app check mods/issue-agent
node --test tests/*.test.mjs
git diff
git add mods README.md tests
git commit -m "feat: describe the change"
git push
```

Keep credentials, screenshots of private repositories, personal settings,
and GitHub issue data out of this public repository. Herdr-generated editor
metadata is ignored.

## What this code accesses

### Open issue sessions

A small orange dot beside an issue number means a matching Herdr session is
open. Click the dot, or the reader's **Session open** badge, to jump to it.
The **Start agent** dialog also warns about existing sessions and offers
**Go to session**, without preventing you from starting another.

Matching uses an explicitly named `#123` tab or an issue branch such as
`feat/123-description`, plus the checkout's GitHub repository URL. This works
for existing worktrees and connected remote machines, not just new launches.
Ambiguous identifiers and unknown repositories are not marked. Arbitrarily
named tabs/branches without an issue number cannot be detected automatically.
The dot means **open session**, including idle/completed agents, not proof
that someone is actively working. Closed tabs no longer count. Discovery runs
every two seconds; repository lookups are cached in memory for one minute.

The panel runs authenticated `gh` commands to read repository issues, PRs,
labels, milestones, and CI checks. The Agent action runs Git to create a
worktree, may copy selected ignored files using `rsync`, and launches your
chosen agent. The CI view can inspect the branches of open Herdr spaces.
Session indicators read Herdr's open tabs/panes and use `gh repo view` in
candidate checkout folders to verify repository identity.
Browser links use `xdg-open`. No credentials or repository data are bundled.

## Restore the previous installation

Find the backup directory printed by the installer under
`~/.config/herdr-app/mod-backups/`. Move the two installed **symlinks** aside,
then move the corresponding backed-up mod directories back into `mods/`.
Restart Herdr. Do not delete the linked checkout while it is installed.

## Files

- `mods/github/panel.js`: lists, filters, milestone picker, title rendering.
- `mods/github/mod.json`: popup size.
- `mods/github/issue-reader.js`: read-only native issue discussion and link handling.
- `mods/github/issue-model.js`: trusted issue URL parsing, history, cache, and request guards.
- `mods/issue-agent/main.js`: worktree creation, dialog, initial prompt.
- `mods/issue-agent/agents.js`: agent-specific model/launch adapters.
- `mods/{github,issue-agent}/sessions.js`: identical sandbox-local session matching helpers.

This repository preserves the existing locally installed mods plus personal
modifications. It is not an official Herdr release. No new license is asserted
over pre-existing code; consult its original authors for redistribution terms.
