import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeDefaultSessionDir,
	defaultSessionDirForCwd,
	hasProjectSessionStore,
	sessionDirsForCwd,
	sessionDirsForListing,
} from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getConfigRootDir, getProjectSessionsDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const cleanup: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function legacySessionDir(sessionsRoot: string, cwd: string): string {
	const name = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return path.join(sessionsRoot, name);
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(() => {
	setAgentDir(path.join(makeTempDir("omp-session-agent-"), "agent"));
});

afterEach(() => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy session directory migration", () => {
	test("keeps a colliding live legacy session reachable through its path", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const source = path.join(legacyDir, "active.jsonl");
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(source, "live-before\n");
		fs.writeFileSync(destination, "stale\n");
		const fd = fs.openSync(source, "a");

		computeDefaultSessionDir(cwd, storage, sessionsRoot);
		fs.writeSync(fd, "live-after\n");
		fs.closeSync(fd);

		expect(fs.readFileSync(source, "utf8")).toBe("live-before\nlive-after\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("stale\n");
	});

	test("preserves writes when an older process recreates its cached legacy directory", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.writeFileSync(destination, "canonical\n");

		fs.mkdirSync(legacyDir, { recursive: true });
		const recreated = path.join(legacyDir, "active.jsonl");
		fs.writeFileSync(recreated, "older-process-write\n");
		computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.readFileSync(recreated, "utf8")).toBe("older-process-write\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("canonical\n");
	});
});

describe("project-local session store", () => {
	test("routes new sessions into the repo only once the store exists", () => {
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();

		const globalDir = defaultSessionDirForCwd(cwd, storage);
		expect(globalDir.startsWith(getSessionsDir())).toBe(true);
		expect(sessionDirsForCwd(cwd, storage)).toEqual([globalDir]);

		fs.mkdirSync(getProjectSessionsDir(cwd), { recursive: true });

		const projectDir = defaultSessionDirForCwd(cwd, storage);
		expect(projectDir).toBe(path.join(cwd, ".omp", "sessions", "project"));
		// The global bucket stays in discovery order so pre-init sessions remain reachable.
		expect(sessionDirsForCwd(cwd, storage)).toEqual([projectDir, globalDir]);
	});

	test("names the project bucket independently of the checkout path", () => {
		const cwd = makeTempDir("omp-session-cwd-");
		const clone = makeTempDir("omp-session-clone-");
		const storage = new FileSessionStorage();

		const original = computeDefaultSessionDir(cwd, storage, getProjectSessionsDir(cwd));
		const relocated = computeDefaultSessionDir(clone, storage, getProjectSessionsDir(clone));

		expect(path.relative(cwd, original)).toBe(path.relative(clone, relocated));
	});

	test("pairs a pinned directory with one sibling root and never invents another", () => {
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const globalDir = computeDefaultSessionDir(cwd, storage, getSessionsDir());
		fs.mkdirSync(getProjectSessionsDir(cwd), { recursive: true });
		const projectDir = path.join(cwd, ".omp", "sessions", "project");

		// A pinned global bucket gains the in-repo store, and vice versa.
		expect(sessionDirsForListing(cwd, storage, globalDir)).toEqual([globalDir, projectDir]);
		expect(sessionDirsForListing(cwd, storage, projectDir)).toEqual([projectDir, globalDir]);
		// A caller-owned directory is scanned alone.
		expect(sessionDirsForListing(cwd, storage, path.join(cwd, "custom-sessions"))).toEqual([
			path.join(cwd, "custom-sessions"),
		]);
	});

	test("scopes the sibling global bucket to the caller's agent dir", () => {
		const cwd = makeTempDir("omp-session-cwd-");
		const tenantAgentDir = makeTempDir("omp-session-tenant-");
		const storage = new FileSessionStorage();
		fs.mkdirSync(getProjectSessionsDir(cwd), { recursive: true });
		const projectDir = path.join(cwd, ".omp", "sessions", "project");

		const dirs = sessionDirsForListing(cwd, storage, projectDir, tenantAgentDir);

		// The tenant's own bucket, never the process-default one.
		expect(dirs[0]).toBe(projectDir);
		expect(dirs[1]!.startsWith(getSessionsDir(tenantAgentDir))).toBe(true);
		expect(dirs.some(dir => dir.startsWith(getSessionsDir()))).toBe(false);
	});

	test("recognizes an existing store when the cwd is reached through a symlink", () => {
		const real = makeTempDir("omp-session-real-");
		const link = path.join(makeTempDir("omp-session-link-"), "checkout");
		const storage = new FileSessionStorage();
		fs.mkdirSync(getProjectSessionsDir(real), { recursive: true });
		fs.symlinkSync(real, link, "dir");

		expect(hasProjectSessionStore(link, storage)).toBe(true);
		expect(defaultSessionDirForCwd(link, storage)).toBe(path.join(real, ".omp", "sessions", "project"));
	});
});
