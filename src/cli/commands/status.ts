// Status command - check if Maestro desktop app is running and reachable

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { withMaestroClient } from '../services/maestro-client';
import { ExitCode } from '../exit-codes';
import { failCommand } from '../services/session-command';

export interface StatusOptions {
	json?: boolean;
}

export async function status(options: StatusOptions = {}): Promise<void> {
	const info = readCliServerInfo();
	if (!info) {
		failCommand('Maestro desktop app is not running', options.json, ExitCode.NotRunning);
	}

	if (!isCliServerRunning()) {
		failCommand(
			'Maestro discovery file is stale (app may have crashed)',
			options.json,
			ExitCode.NotRunning
		);
	}

	try {
		// Ping to verify WebSocket connectivity
		await withMaestroClient(async (client) => {
			await client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong');

			// Get session count
			const sessionsResult = await client.sendCommand<{ type: string; sessions: unknown[] }>(
				{ type: 'get_sessions' },
				'sessions_list'
			);

			const sessionCount = sessionsResult.sessions?.length ?? 0;
			if (options.json) {
				console.log(
					JSON.stringify({ success: true, running: true, port: info.port, agents: sessionCount })
				);
			} else {
				console.log(
					`Maestro is running on port ${info.port} with ${sessionCount} agent${sessionCount !== 1 ? 's' : ''}`
				);
			}
		});
	} catch (error) {
		failCommand(
			error instanceof Error ? error.message : String(error),
			options.json,
			ExitCode.NotRunning
		);
	}
}
