# Friday: working agreements

Project context (architecture, packages, conventions) lives in `openspec/config.yaml` and the specs under `openspec/specs/`. This file only covers *how* we work.

## Change workflow (OpenSpec)

Every non-trivial change goes through OpenSpec. The main checkout (`/Users/rdewit/Projects/labs/friday`, branch `main`) is for **planning and archiving only**. Code for a change is written in that change's own worktree, so several changes can be applied at the same time without touching each other's files.

### 1. Plan on main

- Create and fill in artifacts with `/opsx:new`, `/opsx:continue`, `/opsx:ff` or `/opsx:propose`. Run `openspec validate <change> --strict` before calling planning done.
- Commit only that change's folder, as `Plan <change> change`: `git add openspec/changes/<change> && git commit`. Never sweep in other files. Another session may have uncommitted work in the main checkout.

### 2. Apply in a worktree (always)

When the user runs `/opsx:apply <change>` (or asks to implement a change), do this **before editing any code**:

1. Check that the change's planning artifacts are committed on `main`. If not, stop and ask to commit them first. A worktree only contains committed files.
2. Create the worktree from local `main` (not `origin/main`), then enter it:
   ```bash
   git worktree add .claude/worktrees/<change> -b change/<change> main
   ```
   Then call `EnterWorktree` with `path: .claude/worktrees/<change>`. If the worktree already exists, just enter it.
3. Set the worktree up:
   - `pnpm install --frozen-lockfile && pnpm -r build`. Packages import each other's `dist/`, so tests fail until the workspace is built.
   - `cp ../../../.env .env` if the main checkout has one. It's git-ignored, so worktrees don't get it.
   - `./data` is relative, so each worktree gets its own `friday.db` automatically.
4. Follow the `/opsx:apply` skill from inside the worktree. All paths are relative to the worktree, and the main checkout is never edited during apply.

If the session is already in a worktree for a *different* change, stop and ask. Never mix two changes in one worktree.

### 3. While implementing

- **Tests with every task.** Each task lands with its tests (`node:test` via `tsx`; tests in `packages/*/test/`, `modules/*/test/`). Write or adjust the test first when fixing a bug. Tick a task (`- [x]`) only when its stated verification has actually passed.
- **Run checks per task group**, for the packages touched: `pnpm --filter <pkg> test` and `pnpm --filter <pkg> typecheck`. Always in the foreground, never in the background.
- **Commit per task group** on `change/<change>`. Messages are sentence-case, imperative, with no prefix (e.g. `Store MCP server definitions in friday.db`). Stage explicit paths, including the updated `tasks.md`.
- **Dev servers:** if another worktree may be running one, pick free ports: `FRIDAY_PORT=8081 FRIDAY_CORE_URL=http://localhost:8081 pnpm dev` (Vite picks the next free port itself). Stop every dev server you started before finishing.
- **Scope:** if the implementation needs to deviate from the specs or design, stop and update the artifacts (or ask) instead of silently diverging.

### 4. Quality gate (before saying a change is done)

Run all of these in the worktree, in order, and fix what they find:

1. `pnpm -r build && pnpm -r typecheck && pnpm -r test`. This is the same as CI; it must be green.
2. `/opsx:verify <change>`: implementation matches specs, design and tasks.
3. `/code-review` on the branch diff against `main`, then fix the confirmed findings.
4. `/security-review` when the change touches secrets, auth, crypto, the HTTP API surface, or anything that spawns processes.
5. Docs: README, `.env.example`, `deploy/k8s.yaml` and the `openspec/config.yaml` context updated wherever behaviour or configuration changed.

Report the gate results plainly, including anything skipped or failing.

### 5. Merge, archive, clean up (ask first)

Pushing `main` deploys to the homelab (`.github/workflows/deploy.yml`), and pushing any branch builds an image. So **merging and pushing always need explicit user approval.**

1. `git rebase main` on `change/<change>`, then re-run the step 4.1 checks.
2. From the main checkout: `git merge --no-ff change/<change> -m "Merge <change>: <one-line summary>"`.
3. `/opsx:archive <change>` on `main`, and commit it as `Archive <change> change and sync specs`.
4. Remove the worktree and branch: `ExitWorktree` (`keep`, then `git worktree remove .claude/worktrees/<change> && git branch -d change/<change>`).
5. Push only when the user says so.

## Running several changes at once

- One change = one branch `change/<change>` = one worktree `.claude/worktrees/<change>` = one session.
- `git worktree list` shows what is in flight. `openspec list` shows each change's task progress.
- Before starting an apply, look at the other in-flight changes' `proposal.md` Impact sections. If they touch the same files (e.g. `packages/core/src/app.ts`, `ConfigurationPage.vue`), tell the user and merge the smaller change first. Rebase the other onto `main` afterwards.
- A migration number (`packages/core/src/storage/db.ts`) is claimed at merge time. If `main` has gained a migration with the same version, renumber yours during the rebase.
