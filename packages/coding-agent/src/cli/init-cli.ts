/**
 * `omp init`: make the current directory a git repository (if it is not one
 * already) and give it a committed, project-local session store.
 *
 * Once `<cwd>/.omp/sessions` exists, session discovery treats it as the primary
 * store for that directory while still consulting the global
 * `~/.omp/agent/sessions` tree, so sessions recorded before `omp init` stay
 * reachable.
 */

import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, getProjectSessionsDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";

/** Session-store backups are recovery scratch, never repository history. */
const SESSION_STORE_GITIGNORE = "*.jsonl.*.bak\n";

export interface InitCommandArgs {
	flags: {
		cwd?: string;
		json?: boolean;
	};
}

export interface InitResult {
	/** Directory that was initialized. */
	cwd: string;
	/** Repository root owning `cwd`, once one exists. */
	repoRoot?: string;
	/** True when this run created the repository. */
	repoCreated: boolean;
	/** Directory new sessions for `cwd` are written to. */
	sessionDir: string;
	/** True when this run created the project-local session store. */
	sessionStoreCreated: boolean;
	/** Repository-relative paths staged for the initial commit. */
	staged: string[];
	/** True when the session store is excluded by a gitignore rule, so nothing was staged. */
	ignored: boolean;
	errors: string[];
}

function renderText(result: InitResult): string {
	const lines: string[] = [];
	lines.push(
		result.repoCreated
			? `Initialized git repository at ${result.repoRoot ?? result.cwd}`
			: `Using existing git repository at ${result.repoRoot ?? result.cwd}`,
	);
	lines.push(
		result.sessionStoreCreated
			? `Created project session store ${result.sessionDir}`
			: `Project session store already present at ${result.sessionDir}`,
	);
	if (result.staged.length > 0) {
		lines.push(`Staged ${result.staged.join(", ")}`);
	}
	if (result.ignored) {
		lines.push(
			`Warning: ${path.relative(result.repoRoot ?? result.cwd, result.sessionDir)} is excluded by a gitignore rule — sessions will not be committed until that rule is removed.`,
		);
	}
	lines.push(
		result.ignored
			? "Sessions started in this directory are stored there, but git will not track them."
			: "Sessions started in this directory are now stored in the repository.",
	);
	for (const error of result.errors) lines.push(`Error: ${error}`);
	return `${lines.join("\n")}\n`;
}

/** Create the repository when `cwd` is not already inside one. */
async function ensureGitRepo(cwd: string, result: InitResult): Promise<VcsGitRepo | null> {
	const existing = vcs.git(cwd);
	if (existing) {
		result.repoRoot = existing.info().repoRoot;
		return existing;
	}
	if (!$which("git")) {
		result.errors.push("git is not installed or not on PATH; cannot create a repository.");
		return null;
	}
	const init = await $`git init`.cwd(cwd).quiet().nothrow();
	if (init.exitCode !== 0) {
		result.errors.push(`git init failed: ${init.stderr.toString().trim() || `exit code ${init.exitCode}`}`);
		return null;
	}
	const created = vcs.git(cwd);
	if (!created) {
		result.errors.push(`git init reported success but no repository was found at ${cwd}.`);
		return null;
	}
	result.repoCreated = true;
	result.repoRoot = created.info().repoRoot;
	return created;
}

/**
 * Stage the session store so the repository tracks it. Git cannot track an empty
 * directory, so the store carries a `.gitignore` (excluding recovery backups)
 * which doubles as the placeholder that keeps the directory in the tree.
 */
async function stageSessionStore(
	repo: VcsGitRepo,
	repoRoot: string,
	sessionDir: string,
	result: InitResult,
): Promise<void> {
	const ignoreFile = path.join(sessionDir, ".gitignore");
	await Bun.write(ignoreFile, SESSION_STORE_GITIGNORE);
	const relative = path.relative(repoRoot, ignoreFile);
	const ignoreCheck = await $`git check-ignore -q ${sessionDir}`.cwd(repoRoot).quiet().nothrow();
	if (ignoreCheck.exitCode === 0) {
		result.ignored = true;
		return;
	}
	try {
		await repo.stageFiles([relative]);
		result.staged.push(relative);
	} catch (error) {
		result.errors.push(`git add ${relative} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function runInitCommand(args: InitCommandArgs): Promise<InitResult> {
	const cwd = path.resolve(args.flags.cwd ?? process.cwd());
	const storage = new FileSessionStorage();
	const sessionsRoot = getProjectSessionsDir(cwd);
	const result: InitResult = {
		cwd,
		repoCreated: false,
		sessionDir: "",
		sessionStoreCreated: !storage.existsSync(sessionsRoot),
		staged: [],
		ignored: false,
		errors: [],
	};

	const repo = await ensureGitRepo(cwd, result);
	// Resolve through the runtime path so the created directory is exactly the
	// one sessions started here will be written to.
	result.sessionDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
	if (repo && result.repoRoot) {
		await stageSessionStore(repo, result.repoRoot, result.sessionDir, result);
	}

	process.stdout.write(args.flags.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
	return result;
}
