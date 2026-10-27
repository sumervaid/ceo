# Manifest notes

The reasons behind the shape of `plugin.json`.

## `commands/` and `agents/` are not declared

Both directories load by convention. Declaring either field turns off the
scan of the matching directory. Both fields also take file paths, not
directory paths. A new command goes in `commands/<name>.md`. A new subagent
goes in `agents/<name>.md`. Neither needs a manifest change.

## `hooks` and `mcpServers` are declared

`hooks` points at `./hooks/hooks.json`, which is also the default. The
declaration documents intent. `mcpServers` points at `./.mcp.json`, which
starts the one server.

The server's `args` use `${CLAUDE_PLUGIN_ROOT}`. A bare `dist/mcp/index.js`
resolves against the session's working directory. The server would then
start only from a shell inside this repo.

The server needs a build. `dist/` is not committed. A fresh clone has no
`dist/mcp/index.js` until `pnpm build` runs. The npm package ships `dist/`.

## The status line is not a manifest field

The manifest schema has no `statusLine` key. `statusLine` is a
`settings.json` key. The status line therefore ships as a script plus a
settings snippet. `hooks/README.md` has the snippet.

## Checking a change

```
claude plugin validate .
```
