#!/usr/bin/env node
// SessionStart hook: pull GitHub issues labeled `approved` into beads.
//
// The discovery workflow (.github/workflows/discovery.yml) files issues labeled
// `triage`. When you relabel one `approved`, the next Claude Code session on
// this machine imports it with `bd github pull <number>` and swaps the label to
// `in-beads`, so it's imported once.
//
// It never blocks a session: any problem prints one line and exits 0.
import { execFileSync } from "node:child_process";

function run(cmd, args, { env, timeout = 30_000 } = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
    timeout,
  });
}

function reason(error) {
  const text = String(error.stderr || error.message || error).trim();
  return text.split("\n").find((line) => line.trim()) ?? "unknown error";
}

function note(message) {
  process.stdout.write(`[import-approved] ${message}\n`);
}

function main() {
  let token;
  let repo;
  try {
    token = run("gh", ["auth", "token"]).trim();
    repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  } catch (error) {
    note(`skipped: gh is not available or not signed in (${reason(error)})`);
    return;
  }

  let issues;
  try {
    issues = JSON.parse(
      run("gh", ["issue", "list", "--label", "approved", "--state", "open", "--json", "number,title", "--limit", "50"]),
    );
  } catch (error) {
    note(`skipped: could not list approved issues (${reason(error)})`);
    return;
  }
  if (issues.length === 0) return;

  const [owner, name] = repo.split("/");
  const env = {
    ...process.env,
    GITHUB_TOKEN: token,
    GITHUB_OWNER: owner,
    GITHUB_REPO: name,
    GITHUB_REPOSITORY: repo,
  };

  const imported = [];
  const failed = [];
  for (const { number, title } of issues) {
    try {
      const result = JSON.parse(run("bd", ["github", "pull", String(number), "--json"], { env, timeout: 60_000 }));
      const stats = result.stats ?? {};
      if (!result.success || stats.errors > 0 || (stats.created ?? 0) + (stats.updated ?? 0) === 0) {
        failed.push(`#${number} (${result.error || `bd pulled nothing: ${JSON.stringify(stats)}`})`);
        continue;
      }
      run("gh", ["issue", "edit", String(number), "--remove-label", "approved", "--add-label", "in-beads"]);
      imported.push(`#${number} ${title}`);
    } catch (error) {
      failed.push(`#${number} (${reason(error)})`);
    }
  }

  if (imported.length) note(`imported into beads: ${imported.join("; ")}. Run \`bd ready\` to see them.`);
  if (failed.length) note(`not imported, still labeled approved: ${failed.join("; ")}`);
}

try {
  main();
} catch (error) {
  note(`skipped: ${reason(error)}`);
}
process.exit(0);
