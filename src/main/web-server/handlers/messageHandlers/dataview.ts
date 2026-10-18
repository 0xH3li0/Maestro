/**
 * Dataview WebSocket handler: `dataview_command`, the CLI half of Dataview (`maestro-cli dataview ...`,
 * D8, DV-13).
 *
 * One message carrying an `action`, answered by the SAME DataviewService request methods the
 * `dataview:*` IPC handlers call, so a CLI result is the result the preview shows. The request fields
 * travel as the message's own fields and the service validates them (a bad request throws, and the
 * reply carries the error).
 */

import { logger } from '../../../utils/logger';
import { getDataviewService } from '../../../dataview/dataview-service';
import { LOG_CONTEXT } from './shared';
import type { DataviewCommandAction } from '../../../../shared/dataview';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

const ACTIONS: ReadonlySet<string> = new Set<DataviewCommandAction>([
	'query',
	'queryInline',
	'queryFile',
	'status',
	'rebuild',
]);

function field<T>(message: WebClientMessage, key: string): T {
	return message[key] as T;
}

function run(action: DataviewCommandAction, message: WebClientMessage): Promise<unknown> {
	const service = getDataviewService();
	const filePath = field<string>(message, 'filePath');
	const agentId = field<string>(message, 'agentId');
	switch (action) {
		case 'query':
			return service.query({ filePath, agentId, source: field(message, 'source') });
		case 'queryInline':
			return service.queryInline({ filePath, agentId, expression: field(message, 'expression') });
		case 'queryFile':
			return service.queryFile({ filePath, agentId, block: field(message, 'block') });
		case 'status':
			return Promise.resolve(
				service.indexStatus({ root: field(message, 'root'), agentId: field(message, 'agentId') })
			);
		case 'rebuild':
			return service.rebuildIndex({ root: field(message, 'root'), agentId });
	}
}

export async function handleDataviewCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'dataview_result', ...payload, requestId: message.requestId });
	};

	const action = typeof message.action === 'string' ? message.action : '';
	if (!ACTIONS.has(action)) {
		reply({ success: false, error: `Unknown Dataview action: ${action || '(none)'}` });
		return;
	}
	logger.info(`[Web] Received dataview_command: action=${action}`, LOG_CONTEXT);

	try {
		reply({ success: true, response: await run(action as DataviewCommandAction, message) });
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
