# CEO desktop

A Mac app that runs a team of coding agents on the plans already signed in. Each task gets an isolated branch and worktree. No API key is needed.

## Two ways to work

Workspaces are the hands-on loop. One task gets one branch, a chat with the agent, a diff to review, checks and a pull request.

The team page runs the org. Each project has a team of headless agents. Each agent has a brief, a provider, a budget and a permission level.

| Tab | Does |
| --- | --- |
| Chief of staff | One conversation staffs the work. The chief hires, writes tasks with a definition of done and starts them. The chief's level sets what it may do. The allowance caps what it may give out. |
| Team | Hire by hand, from a role, from a company template or from a suggested team. Edit, give a branch, merge, fire. The drawer shows runs, output and the prompt. |
| Tasks | The queue. A task with checks runs as verified attempts and is done only when an attempt passes. One attempt stays on the assignee's provider. Several attempts let the router compare providers. |
| Live | Every headless run streams here. Notes between agents sit beside it. |
| Map | The team around the chief. Lines are notes and work given out. |
| Approvals | Merges wait here with the evidence. The checkout must be clean. A conflict undoes the merge. |
| Docket | Files, issues, pages, Hugging Face cards, notes and skills, given to chosen agents. |
| Mission | The objective, criteria, rules for everyone and checks. Every agent reads it on every run. |
| Integrations | GitHub, Hugging Face, sandboxes, skills and the ledger check. |

The free plan holds 3 team agents per project. The chief of staff, companies and several attempts per task are part of Pro.

## Layout

| Path | Holds |
| --- | --- |
| `src/main` | The window process: windows, menus, dialogs, notifications and the engine's lifetime. |
| `src/engine` | Everything the app does, in a process of its own. Wraps the core in `../src/core`. Runs with no window, so tests drive it directly. `org.ts` holds the team: chief, agents, tasks, approvals. |
| `src/shared/api.ts` | The contract between the window and the engine. |
| `src/renderer` | The React interface. |
| `test/engine` | Engine tests on stub agents. |
| `test/e2e` | Playwright flows through the real app. `CEO_E2E_EXEC` points them at a packaged build. |
| `test/fake` | A scripted agent and a GitHub CLI with state. Both cost nothing. |

State lives in the project and in `~/.ceo`:

| File | Holds |
| --- | --- |
| `<repo>/.ceo/ledger.jsonl` | The hash-chained record. The CLI and the dashboard read the same file. |
| `<repo>/.ceo/worktrees/<name>` | One worktree per workspace. |
| `<repo>/.ceo/app/` | Workspaces, races, project settings and chat. |
| `~/.ceo/app/` | App settings and the license key. |

`.ceo/` goes into `.git/info/exclude`. No tracked file changes.

## Develop

```sh
npm install
npm run dev        # the app on stub agents, so nothing costs money
npm test           # engine tests
npm run e2e        # every flow through the real app
npm run dist:local # dmg for this Mac, ad-hoc signed
```

Testing never reaches a real CLI. `CEO_REQUIRE_STUBS=1` refuses any binary not named `stub-*`.

## Release

A build that strangers can open needs the steps below, in order.

1. Join the Apple Developer Program. Export a Developer ID Application certificate as a `.p12`.
2. Create an app-specific password at account.apple.com.
3. Run `npm run license:keygen` once, if `.secrets/license.pem` does not exist. Back that file up. Losing it means no new keys. Leaking it means free keys for everyone. It never goes in git.
4. Set a checkout link at build time with `CEO_CHECKOUT_URL`. The upgrade sheet hides the buy button without one.
5. Build:

```sh
export CSC_LINK=/path/to/developer-id.p12 CSC_KEY_PASSWORD=...
export APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...
npm run dist
```

6. Run the flows against the signed build:

```sh
CEO_E2E_EXEC="$PWD/release/mac-arm64/CEO.app/Contents/MacOS/CEO" npx playwright test
```

7. Upload the dmg and zip. Add a `publish` section to `electron-builder.yml` before wiring automatic updates. Updates need a signed build.

## Licenses

A key is `CEO1.<payload>.<signature>`, signed offline with Ed25519. The app holds the public key. Nothing phones home.

```sh
node tools/license.mjs issue buyer@example.com        # no expiry
node tools/license.mjs issue buyer@example.com 365    # one year
```

A payment provider's webhook should call the same signing code and email the key.

| Plan | Holds |
| --- | --- |
| Trial, 14 days | Everything. |
| Free | 3 active workspaces, 3 team agents per project, chat, review, checks, PRs, merge, spend and the ledger. |
| Pro | Unlimited workspaces and team agents, the chief of staff, companies, several attempts per task, Race, Plan, Insights and ledger export. |

All of the code is open source under MIT, the Pro checks included. A build from source can change any limit. The key pays for the official signed build and its upkeep.
