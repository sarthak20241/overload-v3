# mcp.tryoverload.app

A forwarder only. No code runs here. Vercel passes each call on:

| Path on mcp.tryoverload.app | Goes to |
|---|---|
| `/` | the `mcp` edge function (`supabase/functions/mcp`) |
| `/.well-known/oauth-protected-resource` | the function's sign-in info |
| `/.well-known/oauth-authorization-server` | a redirect to Clerk's sign-in server info (for older MCP clients). A redirect, not a rewrite: through a rewrite Clerk names the wrong host as its issuer |

The public MCP URL is `https://mcp.tryoverload.app`. It must match, exactly:

- `RESOURCE` in `supabase/functions/mcp/index.ts` (the function puts it in its sign-in info)
- the MCP URL in Clerk Dashboard -> Agents -> MCP servers (Clerk puts it in each token)

Never change it once users connect: every user would have to connect again.

## How it is deployed

The Vercel project `overload-mcp` is NOT connected to Git. App commits never
build it, so nothing can skip or race a deploy. After changing `vercel.json`,
deploy it by hand from this folder:

```bash
cd mcp-proxy && vercel deploy --prod
```

Set up on 2026-11-10:

1. `vercel link --project overload-mcp` from this folder, then `vercel deploy --prod`.
2. `vercel domains add mcp.tryoverload.app` (to the linked project).
3. Namecheap DNS for tryoverload.app: `A` record, host `mcp`, value `76.76.21.21`.

Check it after any change:

```bash
curl -s https://mcp.tryoverload.app/.well-known/oauth-protected-resource
```

It must name `"resource":"https://mcp.tryoverload.app"` and Clerk as the
authorization server.
