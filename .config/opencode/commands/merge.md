---
description: Review and squash-merge GitHub pull requests into local main.
agent: build
---

Merge pull requests requested by the user: `$ARGUMENTS`.

Follow this workflow exactly:

1. Parse the request to determine which PRs to merge.
   - If explicit PR numbers are provided, such as `#1187`, use those exact PRs.
   - Accept natural-language counts like `last four PRs`, `last 4 prs`, or
     `4`.
   - If neither explicit PR numbers nor a count are clear, ask one short
     clarification question before doing anything else.
2. Read `CONTRIBUTING.md` if it exists. Follow its commit message convention.
   If it links to another convention, inspect that link before composing
   messages.
3. For each PR, review before merging:
   - Inspect title, author login, base branch, head branch, draft state,
     mergeability, review decision, commit list, changed files, checks, and
     full diff.
   - Look for obvious bugs, regressions, performance issues, unsafe changes,
     missing context, or conflicts with repository conventions.
   - Do not merge draft PRs, non-mergeable PRs, PRs with requested changes, or
     PRs that fail required branch protection.
   - If checks are failing or pending, determine whether they are required. Do
     not bypass protections. If the PR can still merge normally, only proceed
     when the code review itself looks safe; otherwise report the blocker.
   - If the review finds bugs, regressions, performance problems, unsafe
     behavior, or repository convention errors, do not merge that PR. Submit a
     blocking PR review using `gh pr review` with `--request-changes` and
     `--body`, tagging the PR contributor and `@pedro757` in the body. The
     review body must clearly list the errors with file and line references when
     available, explain why they block the merge, and mention exactly what needs
     to change.
4. Checkout the PRs to and squash-merge them into local `main` without pushing.
   - Create the worktree outside the repository, for example under
     `/tmp/opencode-merge-pr-<number>-<headSha>`, and check out the PR head
     there.
   - In the worktree, reproduce the Next image type setup from
     `tooling/github/setup/action.yml` before linting:

     ```bash
     echo -e '/// <reference types="next" />\n/// <reference types="next/image-types/global" />' > apps/nextjs/next-env.d.ts
     ```

   - Treat `apps/nextjs/next-env.d.ts` as a generated setup file. Do not stage
     or commit it when it is created only for linting.
   - Run `pnpm lint` and `pnpm format:fix` from the temporary worktree root.
   - If either command fails, do not merge. Submit a blocking PR review using
     `gh pr review` with `--request-changes` and `--body`, tagging the PR
     contributor and `@pedro757` in the body, and include the relevant command
     failure output.
   - If `pnpm format:fix` modifies files, inspect the diff and run `pnpm lint`
     again. Do not push formatting changes. Request changes and include the
     required formatting diff in the review body.
   - After validation passes, remove the validation worktree and return to the
     user's working tree. Require a clean local `main` branch before merging.
     Fetch `origin/main` and update local `main` with a fast-forward only when
     needed. If local `main` cannot be updated safely, report the blocker.
   - Run `git merge --squash --no-commit <reviewed-head-sha>` on local `main`.
     If there are conflicts, do not merge; report the conflict as a blocker and
     request changes with `gh pr review`.
   - Ensure only the intended PR changes are staged. Never include generated
     `apps/nextjs/next-env.d.ts` in the merge commit.
   - Create the squash commit with `git commit` and the custom message below.
     Add `Closes #<number>` as a footer in the commit body.
   - Do not push the merge commit. The requested result is a squash commit on
     local `main` only.
   - After the local commit succeeds, resolve its exact full SHA with
     `git rev-parse HEAD`, then close the PR with
     `gh pr close <number> --comment <body>`. The short comment must say it was
     manually squash-merged into local `main`, include the exact commit SHA,
     and state that the commit was not pushed to `origin/main`.
   - Always remove all temporary worktrees after validation, merge, or failure
     with `git worktree remove --force <path>` and then run `git worktree prune`.
   - Write a custom commit subject; do not copy the PR title.
   - Improve the message based on the diff and the real behavior change.
   - Keep the subject line under 50 characters whenever possible, including
     the contributor handle.
   - End the subject line with the PR contributor's GitHub login, formatted as
     `, @login`. Example: `Fix labels of form fields, @edgarfp`.
   - Use a body only when helpful, wrapping it around 72 columns and explaining
     what changed and why, not how.
5. After merging, verify:
   - Local `main` contains each new squash commit and is ahead of `origin/main`
     by the expected number of commits.
6. Report the merged PR numbers, commit SHAs, and commit subjects. If any PR was
   skipped or reviewed with requested changes, report the exact blocker and do
   not hide partial progress.
