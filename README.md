# OrgMCP

A read-only [MCP](https://modelcontextprotocol.io) server for Salesforce orgs.

Authentication is delegated to the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf org login web`, OAuth 2.0 with PKCE). There is no Connected App to create and no secret handled by this process: tokens stay in the CLI store.

Version 0.1 is read-only: SOQL queries, metadata discovery, limits and org management.

## Requirements

- Node.js 20 or later
- Salesforce CLI (`sf`) installed and available in the PATH

## Install

```bash
git clone https://github.com/firo/orgmcp.git
cd orgmcp
npm install
npm run build
```

Log in to an org (the alias is yours to choose):

```bash
sf org login web --alias myorg
```

## Configure your MCP client

```json
"orgmcp": {
  "command": "node",
  "args": ["/absolute/path/to/orgmcp/dist/index.js"]
}
```

## Tools

- `sf_preflight`: check the prerequisites (CLI, configuration)
- `sf_list_orgs`: list the orgs authorized on this machine
- `sf_login`: authorize an org through the browser
- `sf_org_info`, `sf_limits`: org details and API limits
- `sf_describe_global`, `sf_describe_object`: discover sObjects and fields
- `sf_soql`: run a read-only SOQL query, optionally exporting every page to CSV or JSON
- `sf_soql_more`: fetch the next page of a SOQL query

Large results are truncated to a size limit; use `exportTo` to write the full set to a file.

## Configuration

Optional file `~/.orgmcp/config.json` and environment variables (the variables take precedence):

| Setting | Environment variable | Default |
|---|---|---|
| `defaultOrg` | `ORGMCP_DEFAULT_ORG` | `myorg` |
| `apiVersion` | `ORGMCP_API_VERSION` | the org's own version |
| `pageSizeDefault` | `ORGMCP_PAGE_SIZE` | 200 |
| `exportDir` | `ORGMCP_EXPORT_DIR` | `./exports` |
| `sfCliPath` | `ORGMCP_SF_PATH` | `sf` from PATH |
| `cliTimeoutSeconds` | `ORGMCP_CLI_TIMEOUT` | 45 |
| `authTimeoutSeconds` | `ORGMCP_AUTH_TIMEOUT` | 25 |

## Tests

```bash
npm test
```

The tests use a fake `sf` binary and a local mock server; they never contact a real org.

## Notes

- The tool descriptions and error messages are currently in Italian.
- Query results can contain business or personal data. Keep exports out of version control (`exports/` is git-ignored).
- This is an independent project and is not affiliated with or endorsed by Salesforce.

## License

Apache 2.0, see `LICENSE`.
