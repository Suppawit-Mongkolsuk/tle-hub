# tle-hub

Tle's personal Claude Code plugin marketplace. Add it once per machine, then install only what each project needs.

```
/plugin marketplace add Suppawit-Mongkolsuk/tle-hub
```

## Workflow

```
/plugin install model-foreman@tle-hub
```

## UI/UX

All external plugins are pinned to a commit `sha`, so an upstream change can't reach you until you bump it on purpose.

**Every project**
```
/plugin install web-design-guidelines@tle-hub
/plugin install playwright-eyes@tle-hub
```

**SmartCorp / admin / dashboards**
```
/plugin install interface-design@tle-hub
/plugin install dashboard-design@tle-hub
/plugin install ux-audit@tle-hub
```

**New projects / web pages**
```
/plugin install impeccable@tle-hub
/plugin install ui-ux-pro-max@tle-hub
```

**Optional**
```
/plugin install ui-animation@tle-hub
```

Install per project with `--scope project` if you don't want a plugin active everywhere.

## Notes

| Plugin | Source | Note |
|---|---|---|
| model-foreman | Suppawit-Mongkolsuk/Model-foreman | Tracks the default branch |
| interface-design | Dammyjay93/interface-design | `/interface-design:extract` pulls patterns from existing code |
| dashboard-design | abdiraimov-otabek/dashboard-design-skill | |
| ux-audit | uxuiprinciples/agent-skills | Only `interface-auditor` and `flow-checker` are loaded. Works without an API key; `flow-checker` adds an upgrade note to its output |
| web-design-guidelines | vercel-labs/agent-skills | Fetches the latest rules from GitHub on each review |
| impeccable | pbakaus/impeccable | Runs hooks on SessionStart, after Edit/Write, and on Stop, using a native engine binary it verifies by checksum |
| ui-ux-pro-max | nextlevelbuilder/ui-ux-pro-max-skill | Only the main skill, not the banner/slides/brand extras. Needs Python 3. In existing projects, tell it to keep the current tokens |
| ui-animation | mblode/agent-skills | |
| playwright-eyes | this repo | Playwright MCP + `visual-check` skill. Needs Node; first run downloads a browser |

## Updating a pinned plugin

Change `sha` in `.claude-plugin/marketplace.json` to the new commit, run `claude plugin validate .`, push, then `/plugin marketplace update tle-hub`.
