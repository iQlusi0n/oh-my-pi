import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	listAllSessions,
	listSessionsForCwd,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { defaultSessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getConfigRootDir, getProjectSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const storage = new FileSessionStorage();

let tempDir: string;
let cwd: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-store-"));
	cwd = path.join(tempDir, "repo");
	await fs.mkdir(cwd, { recursive: true });
	setAgentDir(path.join(tempDir, "agent"));
});

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeSession(sessionDir: string, id: string, minute: string): Promise<string> {
	const sessionPath = path.join(sessionDir, `2026-01-01T00-${minute}-00-000Z_${id}.jsonl`);
	await fs.mkdir(sessionDir, { recursive: true });
	await Bun.write(
		sessionPath,
		`${JSON.stringify({ type: "session", id, timestamp: `2026-01-01T00:${minute}:00.000Z`, cwd })}\n`,
	);
	return sessionPath;
}

/** Session store a repository carries in-tree, as created by `omp init`. */
async function projectSessionDir(): Promise<string> {
	await fs.mkdir(getProjectSessionsDir(cwd), { recursive: true });
	return defaultSessionDirForCwd(cwd, storage);
}

describe("project-local session discovery", () => {
	it("lists in-repo and global sessions for the same cwd, newest first", async () => {
		const globalDir = defaultSessionDirForCwd(cwd, storage);
		await writeSession(globalDir, "aaaaaaaa-1111-4000-8000-000000000001", "00");
		const projectDir = await projectSessionDir();
		await writeSession(projectDir, "bbbbbbbb-2222-4000-8000-000000000002", "05");

		const sessions = await listSessionsForCwd(cwd, storage);

		expect(sessions.map(session => session.id)).toEqual([
			"bbbbbbbb-2222-4000-8000-000000000002",
			"aaaaaaaa-1111-4000-8000-000000000001",
		]);
	});

	it("honors a caller-owned session directory verbatim", async () => {
		const projectDir = await projectSessionDir();
		await writeSession(projectDir, "bbbbbbbb-2222-4000-8000-000000000002", "05");
		const customDir = path.join(tempDir, "custom");
		await writeSession(customDir, "cccccccc-3333-4000-8000-000000000003", "10");

		const sessions = await listSessionsForCwd(cwd, storage, customDir);

		expect(sessions.map(session => session.id)).toEqual(["cccccccc-3333-4000-8000-000000000003"]);
	});

	it("resumes a committed in-repo session by id prefix", async () => {
		const projectDir = await projectSessionDir();
		const sessionPath = await writeSession(projectDir, "bbbbbbbb-2222-4000-8000-000000000002", "05");

		const match = await resolveResumableSession("bbbbbbbb", cwd, undefined, storage);

		expect(match?.session.path).toBe(sessionPath);
		expect(match?.scope).toBe("local");
	});

	it("includes the project store in the cross-project listing", async () => {
		const projectDir = await projectSessionDir();
		const sessionPath = await writeSession(projectDir, "bbbbbbbb-2222-4000-8000-000000000002", "05");

		const sessions = await listAllSessions(storage, undefined, cwd);

		expect(sessions.map(session => session.path)).toContain(sessionPath);
	});
});
