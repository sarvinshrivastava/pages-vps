# pages-mcp

Shared HTML pages the chat can create and edit, versioned in git, served over the
web. The claude.ai-artifact equivalent for a self-hosted Open WebUI.

## Tools

| Tool | What it does |
|---|---|
| `list_pages` | Every page with its public URL and last change |
| `read_page` | Current HTML — read before editing |
| `write_page` | Create or replace, recording a revision |
| `page_history` | Revisions newest-first, with ids and notes |
| `read_revision` | A page as it was at a given revision |
| `restore_page` | Roll back, itself recorded as a new revision |
| `share_page` | Set visibility: private, shared or public |
| `rotate_share_link` | Issue a new secret link and revoke the old one |
| `delete_page` | Take a page down; history keeps it recoverable |

## Visibility

Three levels, because "shared" and "public" are genuinely different things:

| | Reachable at | Listed | Who can open it |
|---|---|---|---|
| `private` | nowhere | no | only the tools — it is not on the web |
| `shared` | `/s/<32-hex-id>` | no | anyone you send the link to |
| `public` | `/<slug>` | yes | anyone, and it has a URL you can say aloud |

**New pages are private.** Creating a page does not publish it; sharing is a
separate, deliberate call.

A shared page answers **only** at its secret link — requesting it by slug returns
exactly the same 404 as a page that does not exist, so the slug cannot be used to
probe what is stored. Secret links are served `no-store` and `noindex`.
`rotate_share_link` issues a new id and the old link stops working immediately.

Visibility is stored per page in `<slug>.meta.json` and committed, so
`page_history` shows content changes **and** access changes in one timeline —
"what did this say" and "who could reach it" answered from the same history.

## Why git

History, diffs, rollback and "who changed what when" come free, and stay
inspectable with ordinary tools. If this service dies, the pages are still a
directory of HTML with a git log beside them — recoverable without this code.

`isomorphic-git` rather than shelling out: no git binary in the image, and no
argument-injection surface from model-supplied slugs and messages.

Rolling back writes a **new** commit rather than moving the branch, so a restore
is itself undoable and nothing is lost.

## The two surfaces

- `POST /mcp` — the tools. Bearer-authenticated, reachable only from the `shared`
  Docker network.
- `GET /<slug>` — the rendered page. Public and read-only, fronted by nginx. A
  page nobody else can open is not a shared page.

Slugs are `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`, validated before they ever become
a path, so neither surface has a traversal route. Pages are served with `nosniff`,
`SAMEORIGIN` and `no-referrer` — they are model-authored documents.

## Secrets

`PAGES_MCP_TOKEN` in the vault under `Root` — the bearer Open WebUI presents.
Read once at boot, so rotating it needs a container restart.

## State

The git repo lives in the `pages-data` volume. It is the only durable state here
and the one thing worth backing up.

## The nginx vhost

**Do not copy another vhost from this box.** This one needs three things none of
the others do, and one of the others carries a setting that is actively
dangerous here.

`/etc/nginx/sites-available/pages.vps.sarvinshrivastava.space`:

```nginx
limit_req_zone $binary_remote_addr zone=pages:10m rate=10r/s;  # in http{} context

server {
  listen 443 ssl http2;
  server_name pages.vps.sarvinshrivastava.space;
  # certbot fills in ssl_certificate / ssl_certificate_key

  # 1. The tool endpoint is NOT public. It is bearer-gated, but this container
  #    has a hard memory ceiling and one shared vCPU, and there is no reason for
  #    anything outside the Docker network to reach it at all.
  location = /mcp     { return 404; }
  location ^~ /mcp/   { return 404; }
  location = /healthz { return 404; }

  # 2. The public surface is GET-only and nothing here accepts a body. Do NOT
  #    inherit `client_max_body_size 200m` from the CodePush vhost — that hands
  #    an attacker a 200 MB upload against a 384 MB container.
  client_max_body_size 1k;
  limit_except GET HEAD { deny all; }
  limit_req zone=pages burst=20 nodelay;

  location / {
    proxy_pass http://127.0.0.1:3013;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;

    # 3. NEVER cache. A page that is shared today can be made private tomorrow,
    #    and a cached copy keeps serving it with nothing this service can do.
    proxy_cache off;
    proxy_no_cache 1;
    proxy_cache_bypass 1;

    # The app sets two of these itself; hide the upstream copy first or the
    # browser receives the header twice and behaviour diverges by browser.
    proxy_hide_header X-Frame-Options;
    proxy_hide_header Referrer-Policy;

    add_header Cache-Control "no-store, max-age=0" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;
    add_header Content-Security-Policy
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" always;

    gzip on;
    gzip_types text/html;
    gzip_min_length 1024;
  }
}
```

Then `certbot --nginx --expand -d pages.vps.sarvinshrivastava.space` alongside the
existing names.

Two things that will bite:

- **`add_header` in a `server` block is silently discarded if any `location`
  block also has one.** Keep every `add_header` inside `location /`, exactly as
  above. `always` is required too, or the headers are skipped on the 404s — which
  is most of the security-relevant traffic here.
- **The CSP omits `script-src` entirely, so pages get no JavaScript.** That is
  deliberate and not negotiable at this hostname: `pages.vps.…` is a sibling of
  `secrets.vps.…`, so model-authored JS here could set cookies scoped to the
  parent domain and read any cookie set there. If pages ever need JS, the fix is
  a separate registrable domain, not a looser CSP.

One consequence worth knowing rather than fixing: public pages are indexable, on
purpose. Making one private later does not remove it from Google's index or
cache — that needs a removal request.

## Running it

The volume `pages-mcp_pages-data` is the only copy of every page. The deploy
snapshots it to `/var/backups/pages-mcp/` before it touches anything, keeping 20.

**Restore.** Inspect before you overwrite — the tarball is a plain git repo:

```bash
ls -lt /var/backups/pages-mcp/
mkdir -p /tmp/verify && tar xzf /var/backups/pages-mcp/pages-<ts>.tgz -C /tmp/verify
git -C /tmp/verify log --oneline | head
docker stop pages-mcp          # NOT `compose down -v` — that destroys the volume
docker run --rm -v pages-mcp_pages-data:/data -v /var/backups/pages-mcp:/backup alpine:3.22 \
  sh -c 'rm -rf /data/* /data/..?* ; tar xzf /backup/pages-<ts>.tgz -C /data && chown -R 1000:1000 /data'
docker start pages-mcp
```

The `chown -R 1000:1000` is required — `node` is uid 1000, and a tar extracted as
root leaves the repo unwritable.

**Take a page down right now, without the tools.** Metadata is read from disk on
every request, so this takes effect immediately:

```bash
docker run --rm -v pages-mcp_pages-data:/data alpine:3.22 \
  sh -c 'echo "{\"visibility\":\"private\"}" > /data/<slug>.meta.json'
```

**A share link leaked — which page is it?**
`grep -l '<shareid>' /data/*.meta.json`, then `rotate_share_link`.

**Rotating `PAGES_MCP_TOKEN`** needs `docker restart pages-mcp`; it is read once
at boot and nothing detects a stale one.

**Loose objects.** isomorphic-git never packs, and a commit leaves about three
loose objects. Monthly, with the container paused:
`docker run --rm -v pages-mcp_pages-data:/data alpine/git -C /data gc --prune=now`.
isomorphic-git reads packfiles it did not write, so this is safe, and it shrinks
every subsequent snapshot.
