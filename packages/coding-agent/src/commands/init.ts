/**
 * Initialize a project: git repository plus a committed session store.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { initHelp as commandHelp } from "../cli/command-help";
import { runInitCommand } from "../cli/init-cli";

export default class Init extends Command {
	static description = commandHelp.description;
	static examples = ["omp init", "omp init --cwd ~/projects/demo", "omp init --json"];
	static flags = {
		cwd: Flags.string({ description: "Directory to initialize (default: current directory)" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Init);
		const result = await runInitCommand({ flags: { cwd: flags.cwd, json: flags.json } });
		if (result.errors.length > 0) {
			process.stderr.write(`${result.errors.map(error => `- ${error}`).join("\n")}\n`);
			process.exitCode = 1;
		}
	}
}
