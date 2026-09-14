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

The box's conventions, which this follows: TLS comes from
`include snippets/ssl-vps.conf;` (cert lineage `vps-subdomains`, no `ssl_dhparam`
and no `options-ssl-nginx.conf`), ACME from
`include snippets/acme-challenge.conf;` on port 80, webroot `/var/www/certbot`.
nginx is 1.24, so it is `listen 443 ssl;` — the standalone `http2 on;` directive
needs 1.25.1+.

### 1. A port-80 stub, so the new name can be validated

```bash
cat > /etc/nginx/sites-available/pages.vps.sarvinshrivastava.space <<'EOF'
server {
    listen 80;
    server_name pages.vps.sarvinshrivastava.space;
    include snippets/acme-challenge.conf;
    location / {
        return 301 https://$host$request_uri;
    }
}
EOF
ln -sf /etc/nginx/sites-available/pages.vps.sarvinshrivastava.space \
       /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' \
  http://pages.vps.sarvinshrivastava.space/.well-known/acme-challenge/probe
```

That must print `404`, not `301`. A `301` means the acme include is not winning
and the certificate step will fail.

### 2. Expand the certificate — every existing name must be listed

certbot reissues the lineage with **exactly** what you pass, so a name you leave
out is a name that stops working. Get the current list first:

```bash
certbot certificates | grep -E 'Certificate Name|Domains'
```

Then pass all of them plus the new one. `--webroot` writes only into
`/var/www/certbot` and touches no nginx config, which `--nginx` does not
guarantee — it can rewrite every vhost it thinks it owns.

```bash
certbot certonly --webroot -w /var/www/certbot \
  --cert-name vps-subdomains --expand \
  -d vps.sarvinshrivastava.space \
  -d chat.vps.sarvinshrivastava.space \
  -d key-distributor.vps.sarvinshrivastava.space \
  -d monitoring.vps.sarvinshrivastava.space \
  -d nidra-daily-push.vps.sarvinshrivastava.space \
  -d notion-cache.vps.sarvinshrivastava.space \
  -d otp-relay-backend.vps.sarvinshrivastava.space \
  -d pipeline-runner.vps.sarvinshrivastava.space \
  -d secrets.vps.sarvinshrivastava.space \
  -d status.vps.sarvinshrivastava.space \
  -d umami.vps.sarvinshrivastava.space \
  -d pages.vps.sarvinshrivastava.space
```

certbot prints what it is adding and removing before it acts. **Removing must
say `(None)`.** nginx keeps serving the old certificate until it is reloaded,
and the old one is still valid for the others, so there is no window where
anything breaks.

### 3. The real vhost

The rate-limit zone belongs in `http{}`, not the server block:

```bash
cat > /etc/nginx/conf.d/pages-ratelimit.conf <<'EOF'
limit_req_zone $binary_remote_addr zone=pages:10m rate=10r/s;
EOF
```

Then `/etc/nginx/sites-available/pages.vps.sarvinshrivastava.space`. Write it
with an editor — pasting a heredoc this long into a terminal truncates and
splices lines, and the result still parses.

```nginx
server {
    listen 80;
    server_name pages.vps.sarvinshrivastava.space;
    include snippets/acme-challenge.conf;
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name pages.vps.sarvinshrivastava.space;

    include snippets/ssl-vps.conf;

    # The tool endpoint is NOT public. It is bearer-gated, but this container
    # has a hard memory ceiling and one shared vCPU, and nothing outside the
    # Docker network has any reason to reach it.
    location = /mcp     { return 404; }
    location ^~ /mcp/   { return 404; }
    location = /healthz { return 404; }

    # Do NOT raise this. Nothing on the public surface takes a body except the
    # approval button; the CodePush vhost's 200m here would hand an attacker a
    # 200 MB upload against a 384 MB container.
    client_max_body_size 1k;
    limit_req zone=pages burst=20 nodelay;

    # The only POST on this host: pressing "Publish it" on an approval link.
    # It deliberately has NO Content-Security-Policy of its own — see below.
    location ^~ /approve/ {
        limit_except GET HEAD POST { deny all; }
        proxy_pass http://127.0.0.1:3013;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
        add_header Cache-Control "no-store, max-age=0" always;
        add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
    }

    location / {
        limit_except GET HEAD { deny all; }
        proxy_pass http://127.0.0.1:3013;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;

        # A page shared today can be made private tomorrow. A cached copy would
        # keep serving it with nothing this service can do about it.
        proxy_cache off;
        proxy_no_cache 1;
        proxy_cache_bypass 1;

        # The app sets its own CSP, nosniff, X-Frame-Options and Referrer-Policy
        # on every response. These two are the ones it cannot guarantee from
        # behind a proxy, and they are the ones that matter most here.
        add_header Cache-Control "no-store, max-age=0" always;
        add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
    }
}
```

```bash
nginx -t && systemctl reload nginx
```

Four things that bite, in the order they bit:

- **`add_header` in a `server` block is discarded entirely if any `location`
  also has one.** Every one of them sits inside a `location` for that reason,
  and `always` is required or they are skipped on the 404s — which is most of
  the security-relevant traffic here.
- **Never move a `Content-Security-Policy` up to server level.** Two CSP headers
  are enforced as their intersection. The app's approval page needs
  `form-action 'self'`; a server-level `form-action 'none'` would silently kill
  the Publish button. `^~ /approve/` matching before `location /` is what keeps
  these apart.
- **`systemctl reload nginx` is asynchronous.** A request fired immediately
  after it can return nothing at all. Retry before you debug it.
- **`grep -r` skips symlinks**, and `sites-enabled` is entirely symlinks — use
  explicit paths.

### 4. Verify before trusting it

The first two are `return 404` at the nginx level, so they answer before the
container exists:

```bash
curl -s -o /dev/null -w 'mcp     %{http_code}\n' https://pages.vps.sarvinshrivastava.space/mcp
curl -s -o /dev/null -w 'healthz %{http_code}\n' https://pages.vps.sarvinshrivastava.space/healthz
for h in chat secrets monitoring status umami; do
  curl -s -o /dev/null -w "$h %{http_code}\n" "https://$h.vps.sarvinshrivastava.space/"
done
```

`404`, `404`, and every other hostname still answering — that last loop is the
check that the certificate expand did not break the rest of the box. A `502` on
`/` before the deploy is correct: the vhost is proxying to a container that does
not exist yet.

After the deploy:

```bash
curl -s https://pages.vps.sarvinshrivastava.space/robots.txt
curl -sI https://pages.vps.sarvinshrivastava.space/ | grep -i x-robots-tag
```

Nothing here is indexable. Every page response carries
`X-Robots-Tag: noindex, nofollow, noarchive`, `/robots.txt` disallows everything,
and the vhost repeats the header so it holds even if the app is bypassed. A page
that got indexed would outlive any later decision to take it down — the URL stays
in the index and the cache, and this service cannot purge either.

## Publishing needs a human

`share_page` can set `private` and `shared` on its own. It **cannot** set
`public`. That asks instead: the service pushes a notification to
`PAGES_NTFY_URL` with a one-time link, and the page does not change until
someone opens that link and presses the button.

The approval token is never returned to the model. That is the whole point — a
`confirm: true` argument, or a token handed back to be echoed, is something the
model can satisfy in the same turn, and a document carrying injected
instructions would satisfy it just as easily. The token exists only in the push
notification, is single-use, and expires after 15 minutes. Pending requests live
in memory, so a restart drops them, which fails closed.

If `PAGES_NTFY_URL` is absent or unparseable, `public` is refused outright and
the reason says so. It never falls back to publishing.

Set it to a full ntfy topic URL, e.g. `https://ntfy.sh/<something-unguessable>`.
**The topic name is the credential** — anyone who knows it can read your
approval requests, so do not reuse the VPS alerts topic and do not pick
something guessable.

One thing to keep true: if `pages-mcp` is ever added to bridge-mcp's
`SERVICE_REGISTRY`, give it `methods: ["GET"]` and deny `^/approve/`. A POST
reachable from chat would let the model approve its own request, and the gate
would be worth nothing.

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
