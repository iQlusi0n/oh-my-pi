import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import {
	getProjectSessionsDir,
	getSessionsDir,
	getTerminalSessionsDir,
	isEnoent,
	logger,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "./session-storage";

const migratedSessionRoots = new Set<string>();

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function migrateSessionDirPath(oldPath: string, newPath: string): void {
	const existing = fs.statSync(newPath, { throwIfNoEntry: false });
	if (existing?.isDirectory()) {
		for (const file of fs.readdirSync(oldPath)) {
			const src = path.join(oldPath, file);
			const dst = path.join(newPath, file);
			if (fs.existsSync(dst)) {
				logger.warn("Session directory migration collision; preserving legacy entry", { src, dst });
				continue;
			}
			fs.renameSync(src, dst);
		}
		fs.rmdirSync(oldPath);
		return;
	}
	if (existing) {
		fs.rmSync(newPath, { recursive: true, force: true });
	}
	fs.renameSync(oldPath, newPath);
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

/**
 * Reconstruct the short-lived hashed session dir name used by 17.2.5-17.2.8
 * (reverted PR #7397): `<scope>-<readable>-<sha256hex>` keyed by the canonical
 * cwd. Kept only so {@link migrateHashedSessionDir} can recover sessions
 * stranded when 17.2.9 restored the legacy names without a reverse migration.
 */
function encodeHashedSessionDirName(canonicalCwd: string, scope: "home" | "tmp" | "abs"): string {
	const normalized = canonicalCwd.replaceAll("\\", "/");
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = Bun.SHA256.hash(normalized, "hex");
	return `${scope}-${readable || "project"}-${digest}`;
}

function getDefaultSessionDirName(cwd: string): {
	encodedDirName: string;
	hashedDirName: string;
	resolvedCwd: string;
} {
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = resolveEquivalentPath(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = resolveEquivalentPath(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = resolveEquivalentPath(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);
	let encodedDirName: string;
	let scope: "home" | "tmp" | "abs";
	if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
		encodedDirName = encodeRelativeSessionDirName("-", homeRelative);
		scope = "home";
	} else if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
		encodedDirName = encodeRelativeSessionDirName("-tmp", tempRelative);
		scope = "tmp";
	} else {
		encodedDirName = encodeLegacyAbsoluteSessionDirName(canonicalCwd);
		scope = "abs";
	}
	return { encodedDirName, hashedDirName: encodeHashedSessionDirName(canonicalCwd, scope), resolvedCwd };
}

/**
 * Migrate old `--<home-encoded>-*--` session dirs to the new `-*` format.
 * Runs once per sessions root on first access, best-effort.
 */
function migrateHomeSessionDirs(sessionsRoot: string): void {
	if (migratedSessionRoots.has(sessionsRoot)) return;
	migratedSessionRoots.add(sessionsRoot);

	const home = os.homedir();
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const oldPrefix = `--${homeEncoded}-`;
	const oldExact = `--${homeEncoded}--`;

	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
		return;
	}

	for (const entry of entries) {
		let remainder: string;
		if (entry === oldExact) {
			remainder = "";
		} else if (entry.startsWith(oldPrefix) && entry.endsWith("--")) {
			remainder = entry.slice(oldPrefix.length, -2);
		} else {
			continue;
		}

		const newName = remainder ? `-${remainder}` : "-";
		const oldPath = path.join(sessionsRoot, entry);
		const newPath = path.join(sessionsRoot, newName);

		try {
			migrateSessionDirPath(oldPath, newPath);
		} catch (error) {
			logger.warn("Failed to migrate legacy home session directory", {
				oldPath,
				newPath,
				error: String(error),
			});
		}
	}
}

function migrateLegacyAbsoluteSessionDir(cwd: string, sessionDir: string, sessionsRoot: string): void {
	const legacyDir = path.join(sessionsRoot, encodeLegacyAbsoluteSessionDirName(cwd));
	if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) return;

	try {
		migrateSessionDirPath(legacyDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate legacy session directory", {
			oldPath: legacyDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

/**
 * Migrate a 17.2.5-17.2.8 hashed session dir back into its legacy path-based
 * directory. The 17.2.9 revert restored the legacy names but dropped migration,
 * stranding sessions written under the hashed scheme (issue #7677). Best-effort.
 */
function migrateHashedSessionDir(hashedDirName: string, sessionDir: string, sessionsRoot: string): void {
	const hashedDir = path.join(sessionsRoot, hashedDirName);
	if (hashedDir === sessionDir || !fs.existsSync(hashedDir)) return;

	try {
		migrateSessionDirPath(hashedDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate hashed session directory", {
			oldPath: hashedDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	// A project-local store is pinned to its repository, so a cwd change means a
	// different project entirely: never carry the session into the new cwd's
	// bucket inside the old repo.
	if (isProjectSessionsRoot(cwd, path.dirname(sessionDir))) return undefined;
	const { encodedDirName } = getDefaultSessionDirName(cwd);
	if (currentDirName !== encodedDirName && currentDirName !== encodeLegacyAbsoluteSessionDirName(cwd)) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/**
 * Compute the default session directory for a cwd.
 * Classifies cwd by canonical location so symlink/alias paths resolve to the
 * same home-relative or temp-root directory names as their real targets.
 */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	if (isProjectSessionsRoot(cwd, sessionsRoot)) {
		const sessionDir = path.join(sessionsRoot, PROJECT_SESSION_BUCKET);
		storage.ensureDirSync(sessionDir);
		return sessionDir;
	}
	const { encodedDirName, hashedDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	migrateHomeSessionDirs(sessionsRoot);
	const sessionDir = path.join(sessionsRoot, encodedDirName);
	migrateLegacyAbsoluteSessionDir(resolvedCwd, sessionDir, sessionsRoot);
	migrateHashedSessionDir(hashedDirName, sessionDir, sessionsRoot);
	storage.ensureDirSync(sessionDir);
	return sessionDir;
}

// =============================================================================
// Session roots: project-local (.omp/sessions) + global (~/.omp/agent/sessions)
// =============================================================================

/**
 * Bucket directory inside a project-local sessions root.
 *
 * The global root keys its buckets by encoded cwd, but a project root is already
 * scoped to one repository — and a path-derived name would break as soon as the
 * repo is cloned elsewhere. A fixed name keeps committed sessions discoverable
 * from any checkout while preserving the `<root>/<bucket>/<file>.jsonl` shape
 * that session/stats consumers derive nesting depth from.
 */
export const PROJECT_SESSION_BUCKET = "project";

/** Scope of a sessions root, in discovery order. */
export type SessionRootScope = "project" | "global";

export interface SessionRoot {
	/** Absolute sessions root (contains per-project bucket directories). */
	root: string;
	scope: SessionRootScope;
}

export function isProjectSessionsRoot(cwd: string, sessionsRoot: string): boolean {
	return path.resolve(sessionsRoot) === path.resolve(getProjectSessionsDir(path.resolve(cwd)));
}

/**
 * True when `cwd` carries a project-local session store. Existence is the opt-in
 * switch: without it omp behaves exactly as it did before project roots existed.
 */
export function hasProjectSessionStore(cwd: string, storage: SessionStorage): boolean {
	return storage.existsSync(getProjectSessionsDir(path.resolve(cwd)));
}

/**
 * Sessions roots to consult for `cwd`, most specific first. The project-local
 * root is included only when it exists; the global root is always included so
 * sessions recorded before `omp init` stay reachable.
 */
export function sessionRootsForCwd(cwd: string, storage: SessionStorage, agentDir?: string): SessionRoot[] {
	const roots: SessionRoot[] = [];
	if (hasProjectSessionStore(cwd, storage)) {
		roots.push({ root: getProjectSessionsDir(path.resolve(cwd)), scope: "project" });
	}
	roots.push({ root: getSessionsDir(agentDir), scope: "global" });
	return roots;
}

/**
 * Directory new sessions for `cwd` are written to: the project-local store when
 * present, else the global cwd-derived directory.
 */
export function defaultSessionDirForCwd(cwd: string, storage: SessionStorage, agentDir?: string): string {
	const [primary] = sessionRootsForCwd(cwd, storage, agentDir);
	return computeDefaultSessionDir(cwd, storage, primary!.root);
}

/**
 * Every default session directory for `cwd`, in discovery order. Used by
 * listings so sessions stored in the repo and sessions stored globally for the
 * same cwd both show up.
 */
export function sessionDirsForCwd(cwd: string, storage: SessionStorage, agentDir?: string): string[] {
	const dirs: string[] = [];
	for (const { root } of sessionRootsForCwd(cwd, storage, agentDir)) {
		const dir = computeDefaultSessionDir(cwd, storage, root);
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
}

/**
 * True when `sessionDir` is one of the directories omp would pick for `cwd` on
 * its own. Pure path math: callers use it to decide whether an explicitly passed
 * session directory is a managed default (safe to widen to every root) or a
 * caller-owned custom directory (must be honored verbatim).
 */
export function isDefaultSessionDir(cwd: string, sessionDir: string, agentDir?: string): boolean {
	const resolved = path.resolve(sessionDir);
	const resolvedCwd = path.resolve(cwd);
	if (resolved === path.join(getProjectSessionsDir(resolvedCwd), PROJECT_SESSION_BUCKET)) return true;
	const { encodedDirName } = getDefaultSessionDirName(resolvedCwd);
	const globalRoot = getSessionsDir(agentDir);
	return (
		resolved === path.join(globalRoot, encodedDirName) ||
		resolved === path.join(globalRoot, encodeLegacyAbsoluteSessionDirName(resolvedCwd))
	);
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 *
 * `fresh` marks a freshly minted, lazy session whose JSONL is not yet
 * materialized. A fresh breadcrumb is honored by
 * {@link readTerminalBreadcrumbEntry} even when its target file is still absent,
 * so a same-terminal relaunch does not fall back to an older transcript. Explicit
 * `SessionManager.newSession()` boundaries are materialized and therefore also
 * survive relaunches whose terminal identity changed. Once any lazy session
 * materializes, the caller rewrites the breadcrumb with `fresh:false` so a later
 * external delete is still treated as a genuinely stale crumb.
 */
export function writeTerminalBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbDir = getTerminalSessionsDir();
	const breadcrumbFile = path.join(breadcrumbDir, terminalId);
	const content = fresh ? `${cwd}\n${sessionFile}\nfresh\n` : `${cwd}\n${sessionFile}\n`;
	// Synchronous + best-effort. Infrequent (session create/switch/reset, never
	// per-append), and writing in order matters: a lazy fresh-session crumb is
	// re-stamped non-fresh the instant the session materializes, so an async
	// fire-and-forget could land the two writes out of order and leave a
	// materialized session marked fresh.
	try {
		fs.mkdirSync(breadcrumbDir, { recursive: true });
		fs.writeFileSync(breadcrumbFile, content);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb write failed", { err });
	}
}

export interface TerminalBreadcrumb {
	cwd: string;
	sessionFile: string;
	/** The recorded session file exists on disk right now. */
	exists: boolean;
	/** Recorded as a `/new` fresh-session boundary whose JSONL may not exist yet. */
	fresh: boolean;
}

/**
 * Read the raw terminal breadcrumb for the current terminal.
 * Returns the recorded cwd + session file regardless of whether the recorded
 * cwd still matches the current one. Callers decide how to interpret a cwd
 * mismatch (e.g. a moved/renamed worktree).
 *
 * A missing target file yields `null` UNLESS the breadcrumb is a `fresh`
 * boundary — a lazy session whose JSONL was never written — in which case the
 * entry is returned with `exists:false` so the caller can distinguish it from a
 * genuinely stale/deleted breadcrumb.
 */
export async function readTerminalBreadcrumbEntry(): Promise<TerminalBreadcrumb | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const content = await Bun.file(breadcrumbFile).text();
		const lines = content.trim().split("\n");
		if (lines.length < 2) return null;

		const breadcrumbCwd = lines[0];
		const sessionFile = lines[1];
		const fresh = lines[2] === "fresh";

		const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
		const exists = stat?.isFile() === true;
		// A materialized target resumes normally; a missing target is honored only
		// for a never-written lazy fresh-session boundary.
		if (exists || fresh) return { cwd: breadcrumbCwd, sessionFile, exists, fresh };
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}
