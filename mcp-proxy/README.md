# mcp.tryoverload.app

A forwarder only. No code runs here. Vercel passes each call on:

| Path on mcp.tryoverload.app | Goes to |
|---|---|
| `/` | the `mcp` edge function (`supabase/functions/mcp`) |
| `/.well-known/oauth-protected-resource` | the function's sign-in info |
| `/.well-known/oauth-authorization-server` | Clerk's sign-in server info (for older MCP clients) |

The public MCP URL is `https://mcp.tryoverload.app`. It must match, exactly:

- `RESOURCE` in `supabase/functions/mcp/index.ts` (the function puts it in its sign-in info)
- the MCP URL in Clerk Dashboard -> Agents -> MCP servers (Clerk puts it in each token)

Never change it once users connect: every user would have to connect again.

## Set up (once)

1. Vercel: New Project -> import this repo -> Root Directory `mcp-proxy` ->
   Framework "Other" -> Deploy.
2. Vercel project -> Settings -> Domains -> add `mcp.tryoverload.app`.
3. Namecheap DNS for tryoverload.app: add `CNAME` record, host `mcp`,
   value `cname.vercel-dns.com`.
4. Vercel project -> Settings -> Git -> Ignored Build Step: only build when
   `mcp-proxy/` changes (`git diff --quiet HEAD^ HEAD -- .`), so app commits
   do not make new deploys here.
