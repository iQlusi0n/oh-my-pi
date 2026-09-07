import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runInitCommand } from "@oh-my-pi/pi-coding-agent/cli/init-cli";
import { defaultSessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

let tempDir: string;
let cwd: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-init-cli-"));
	cwd = path.join(tempDir, "repo");
	await fs.mkdir(cwd, { recursive: true });
	spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function trackedPaths(): Promise<string[]> {
	const repo = vcs.requireGit(cwd);
	return await repo.changedFiles({ cached: true });
}

describe("omp init", () => {
	it("creates a repository whose tracked session store receives new sessions", async () => {
		const result = await runInitCommand({ flags: { cwd } });

		expect(result.errors).toEqual([]);
		expect(result.repoCreated).toBe(true);
		expect(result.repoRoot).toBe(cwd);
		expect(result.sessionDir).toBe(path.join(cwd, ".omp", "sessions", "project"));
		expect(await trackedPaths()).toEqual([path.join(".omp", "sessions", "project", ".gitignore")]);
		// The store is what session writes actually resolve to afterwards.
		expect(defaultSessionDirForCwd(cwd, new FileSessionStorage())).toBe(result.sessionDir);
	});

	it("adopts an existing repository instead of nesting a new one", async () => {
		await Bun.spawn(["git", "init", "-q"], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
		const nested = path.join(cwd, "packages", "app");
		await fs.mkdir(nested, { recursive: true });

		const result = await runInitCommand({ flags: { cwd: nested } });

		expect(result.repoCreated).toBe(false);
		expect(result.repoRoot).toBe(cwd);
		expect(result.sessionDir).toBe(path.join(nested, ".omp", "sessions", "project"));
	});

	it("reports an excluded store instead of silently leaving sessions untracked", async () => {
		await Bun.spawn(["git", "init", "-q"], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
		await Bun.write(path.join(cwd, ".gitignore"), ".omp/\n");

		const result = await runInitCommand({ flags: { cwd } });

		expect(result.ignored).toBe(true);
		expect(result.staged).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("re-running leaves an existing store and its sessions intact", async () => {
		const first = await runInitCommand({ flags: { cwd } });
		const sessionFile = path.join(first.sessionDir, "2026-01-01T00-00-00-000Z_existing.jsonl");
		await Bun.write(sessionFile, `${JSON.stringify({ type: "session", id: "existing" })}\n`);

		const second = await runInitCommand({ flags: { cwd } });

		expect(second.sessionStoreCreated).toBe(false);
		expect(second.repoCreated).toBe(false);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
	});
});
