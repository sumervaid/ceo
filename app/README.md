# CEO desktop

A Mac app that runs a team of coding agents on the plans already signed in. Each task gets an isolated branch and worktree. No API key is needed.

## Layout

| Path | Holds |
| --- | --- |
| `src/main` | The window process: windows, menus, dialogs, notifications and the engine's lifetime. |
| `src/engine` | Everything the app does, in a process of its own. Wraps the core in `../src/core`. Runs with no window, so tests drive it directly. |
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
| Free | 3 active workspaces, chat, review, checks, PRs, merge, spend and the ledger. |
| Pro | Unlimited workspaces, Race, Plan, Insights and ledger export. |
