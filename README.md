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
