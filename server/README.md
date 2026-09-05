# enhance-mcp

MCP server for the Enhance hosting control panel. Part of the Enhance plugin for Claude Code; see the repository README for installation. Run `enhance-mcp doctor` to check configuration, `enhance-mcp serve` (default) to start over stdio. In a git checkout the bin is not on your PATH yet; run `node dist/index.js doctor` from `server/` after `npm run build`.

## Developing

```
npm ci
npm run typecheck
npm test
npm run build
```

Use `npm ci` (the lockfile is committed; with the lockfile present, `npm install` is fine too). A fresh `npm install` without the lockfile can intermittently fail on npm 10.9 with `Cannot read properties of null (reading 'edgesOut')`; that is an npm resolver bug, not a dependency conflict (`npm ls` is clean). Re-run it, or use `npm ci`.
