/**
 * CLI >= 2.15x: `sf org display` restituisce "[REDACTED]" al posto del token.
 * Il server deve ripiegare su --verbose e, se serve, scambiare il refresh token
 * dello sfdxAuthUrl con un access token nuovo.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "orgmcp-redacted-"));
const fakeSf = join(work, "sf");
let ok = 0, ko = 0;
const assert = (c, m) => { if (c) { ok++; console.log("  ok  - " + m); } else { ko++; console.log("  FAIL - " + m); } };

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/services/oauth2/token") {
      const p = new URLSearchParams(body);
      const good = p.get("grant_type") === "refresh_token" && p.get("client_id") === "PlatformCLI" && p.get("refresh_token") === "5Aep861!abc:def";
      return res.end(JSON.stringify(good ? { access_token: "00D000!NEWTOKEN", instance_url: `http://127.0.0.1:${server.address().port}` } : { error: "invalid_grant" }));
    }
    res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

writeFileSync(fakeSf, `#!/bin/bash
case "$*" in
  *"--version"*) echo "@salesforce/cli/2.154.4 darwin-arm64 node-v24" ;;
  *"--verbose"*) echo '{"status":0,"result":{"id":"00D1","accessToken":"[REDACTED]","instanceUrl":"http://127.0.0.1:${port}","username":"u@example.com","apiVersion":"68.0","connectedStatus":"Connected","sfdxAuthUrl":"force://PlatformCLI::5Aep861!abc:def@127.0.0.1:${port}"}}' ;;
  *"org display"*) echo '{"status":0,"result":{"id":"00D1","accessToken":"[REDACTED]","instanceUrl":"http://127.0.0.1:${port}","username":"u@example.com","apiVersion":"68.0","connectedStatus":"Connected"}}' ;;
  *) echo '{"status":1,"message":"x"}'; exit 1 ;;
esac
`);
chmodSync(fakeSf, 0o755);
process.env.ORGMCP_SF_PATH = fakeSf;
process.env.ORGMCP_DEFAULT_ORG = "myorg";

const { getOrgAuth } = await import("../dist/sf.js");
try {
  const auth = await getOrgAuth("myorg", true);
  assert(auth.accessToken === "00D000!NEWTOKEN", "token mascherato: usa il refresh token dello sfdxAuthUrl");
  assert(auth.apiVersion === "68.0", "mantiene la versione API della org");
} catch (e) { assert(false, "getOrgAuth non deve fallire: " + e.message); }
server.close();
console.log(`\nredacted: ${ok} ok, ${ko} falliti`);
process.exit(ko ? 1 : 0);
