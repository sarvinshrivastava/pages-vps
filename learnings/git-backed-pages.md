# Running a git-backed page store from isomorphic-git

> **Rule:** validate the slug where the filesystem path is built, never in a handler.

Measured against isomorphic-git 1.42.2. Most of this is about the library
behaving reasonably but not the way the calling code assumed.

## `depth` bounds the result count, not the walk

- `git.log({ filepath, depth: 1 })` does not read one commit. With a `filepath`,
  a commit is pushed only when that file's oid *changes*, so the walk runs from
  HEAD back until it reaches the page's last edit — inflating every commit object
  and resolving the tree path on the way.
- Measured: 33 ms for a page last edited 200 commits ago, 1 ms for a just-edited
  one. Linear in commits-since-that-page-last-changed, and `listPages` called it
  once per page.
- Nothing is cached between calls unless you pass a shared `cache: {}`.
- The fix that actually scales is not to call it: cache the change note in the
  page's own metadata at write time, since the metadata is written in the same
  commit anyway.

## `force: true` is what makes a deleted file's history readable

- Without it, `_log` throws `NotFoundError` when the filepath is absent from
  HEAD's tree. A `.catch(() => [])` around that turns "this page was deleted"
  into "this page has no history" — which quietly made `delete_page` an
  unrecoverable operation despite its own docs promising otherwise.
- Cost: `force` also stops the walk breaking at the file's creation commit, so it
  runs to the root. Bound it with `depth`.

## Commit timestamps are second-resolution, so do not sort by them

- A create followed by a share inside one model turn ties. `Array.prototype.sort`
  is stable, so the tie keeps concatenation order and the older commit lands
  first in a list documented newest-first.
- Order by git's own walk instead: `git.log({ depth })` with no filepath, build
  `oid -> index`, sort by that. Authoritative on a linear history.

## Concurrent writes silently discard commits

- `git.add` and `git.commit` share one on-disk index and one HEAD. Six parallel
  `write_page` calls each returned a commit id; five were dangling — reachable by
  id that day, gone at the next gc, absent from history all along.
- One promise chain serialising every write fixes it. Open WebUI runs a single
  turn's tools sequentially, so this needs two chats at once — a normal state for
  a shared instance, not an exotic one.

## A health check that cannot fail is not a health check

- `{status: true}` returned once boot completed could not see: a volume that
  failed to mount, a read-only remount, a full disk, a `.git` corrupted by an OOM
  kill mid-commit, or a restore done with the wrong ownership.
- The volume-not-mounted case is the worst, because the Dockerfile bakes
  `/data/pages` into the image (that is what gives the volume `node` ownership on
  first mount) — so a missing volume is indistinguishable from a first boot, and
  `git.init` writes a fresh empty history over the top and reports healthy.
- Check `/proc/self/mountinfo` field 5 for the mount point, and make `/healthz`
  read `.git/HEAD`, write and delete a probe file, and return the page count.
  The count is the volume-loss canary.

## Two lockfiles for one tree

- `npm install --package-lock-only` run against a `node_modules` that bun
  installed produces a lockfile with **zero** `integrity` and `resolved` fields.
  `npm ci` still installs from it, with no subresource-integrity check at all.
- Regenerate from `package.json` alone, in an empty directory, and keep only the
  lockfile the image is actually built from.

## A confirmation the model can satisfy is not a confirmation

- `confirm: true` as a tool argument, or a token returned to the model to send
  back, are both satisfiable inside one turn. A document carrying injected
  instructions satisfies them just as easily as a person would.
- The gate has to be a channel the model cannot reach. Here: a push notification
  carrying a one-time link, with the token never returned to the model.
- Which makes one integration rule load-bearing — if this service is ever added
  to bridge-mcp's `SERVICE_REGISTRY`, it must be `methods: ["GET"]` with
  `^/approve/` denied. A POST reachable from chat lets the model approve its own
  request and the gate is worth nothing.
- Fail closed: no channel configured means `public` is refused, never published
  without approval. Pending requests are in memory so a restart drops them.

## "Public" and "indexable" are different decisions

- A share link had `X-Robots-Tag: noindex` and a public page had nothing, which
  quietly made publishing an irreversible act: the URL and a cached copy stay in
  the index long after the page is taken down, and the service cannot purge
  either.
- Three layers, because each covers a different bypass: the header on every
  response, `/robots.txt` (what a crawler checks before fetching at all), and the
  same header from nginx (holds if the app is bypassed or replaced).
- `noarchive` is the one people forget — it is what stops the cached copy.

## `grep -q` on a streaming response hangs the pipeline forever

- A CI smoke step sat for 5h42m and was killed by hand. The log stopped after the
  last assertion that piped curl into `python3`, and never printed the next one,
  which piped curl into `grep -q`.
- `grep -q` exits on its first match. That collapses the pipe while `curl` is
  still holding an open Streamable-HTTP/SSE response: curl has nothing left to
  write, so it never sees EPIPE, and sits in `read()`. `set -o pipefail` makes
  bash wait for every member of the pipeline, including that curl.
- A consumer that reads to EOF (`python3 -c`, command substitution) does not do
  this, which is why the assertion immediately before it passed.
- Three fixes, all of them worth having: `--max-time` on every curl so a hang
  becomes a failing assertion in seconds; `case "$out" in *word*)` against a
  captured variable instead of piping into an early-exiting consumer; and
  `timeout-minutes` on the step so nothing can ever consume the job's whole
  budget again.
- Checked and NOT a bug, having tested it: `cmd | grep -q X && fail "..."` is
  safe under `set -e`. Bash exempts every command in an AND-OR list except the
  last, so a non-matching grep does not abort the step.

## A bare `wait` waits for the stub server too

- The same step starts a stub vault with `&`, and the stub runs
  `serve_forever()`. A later `wait` with no arguments waits for **every**
  background job in the shell, that server included — so it never returns.
- This was the actual cause of the 5h42m hang. The `grep -q` pipeline above is a
  real hazard and worth fixing, but it was not what hung: GitHub Actions log
  output buffers, so the last flushed line was several assertions behind where
  execution had actually reached.
- The lesson is the diagnostic one: **"the log stops at line N" means "the log
  flushed up to line N", not "execution reached line N".** Do not anchor a
  diagnosis to the last line printed.
- Collect the PIDs you actually care about and `wait "${pids[@]}"`.

## `x=$(a | b)` under `set -e` + `pipefail` swallows its own error message

- `id=$(tool share_page ... | grep -o '[0-9a-f]\{32\}' | head -1)` followed by
  `[ -n "$id" ] || fail "share_page returned no share id"` never prints that
  message. If `grep -o` matches nothing it exits 1, `pipefail` propagates it to
  the assignment, and `set -e` kills the step *before* the check below it runs.
- `head -1` closes the pipe as soon as it has a line, which can also hand the
  upstream stage exit 141 on SIGPIPE — the same abort, on a passing case.
- So the assertion that was written to explain the failure is exactly the one
  that cannot run. End every such assignment with `|| true` and let the explicit
  check do the reporting.
- This is a diagnosability bug, not a correctness one: the verdict is right, the
  message is missing. Which is worse than it sounds when the feedback loop is a
  CI run.
