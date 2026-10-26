/**
 * Source for the bundled `maestro-sketch` MCP server script (docs/sketch-book-spec.md
 * section 4, tools T1-T12).
 *
 * The agent's MCP client spawns it as a stdio subprocess from the provider's MCP
 * config entry (sketch-mcp-install.ts). It shares Coworking's bridge client and
 * MCP stdio loop (`buildMcpStdioServerScript()`), dials the `maestro-sketch`
 * bridge socket (sketch-mcp-bridge.ts), and binds at `hello` with the agent id
 * from `MAESTRO_SKETCH_AGENT_ID` plus its `ppid`. Every tool call is forwarded
 * verbatim as `{method: <tool name>, params: <arguments>}`; the bridge checks
 * identity and ownership, and the tool service checks the argument shapes.
 *
 * Written to `<userData>/sketch-mcp-server.js` while the `sketchBook` flag is on.
 */

import {
	buildMcpStdioServerScript,
	type McpToolDefinition,
} from '../utils/mcp-stdio-server-script';
import {
	SKETCH_AGENT_ID_ENV_VAR,
	SKETCH_MCP_SERVER_NAME,
	SKETCH_SOCKET_ENV_VAR,
	SKETCH_SOCKET_OVERRIDE_ENV_VAR,
	type SketchToolName,
} from './sketch-mcp-types';

/** Most elements one `sketch_add_elements` call may add (spec section 4, T5). */
export const SKETCH_MAX_ELEMENTS_PER_CALL = 500;
/** Largest `sketch_chat_post` text, in UTF-8 bytes (spec section 4 caps). */
export const SKETCH_MAX_CHAT_POST_BYTES = 64 * 1024;
/** Largest `sketch_screenshot` scale, in PNG pixels per scene pixel (T9). */
export const SKETCH_MAX_SCREENSHOT_SCALE = 4;

/** A tool definition whose name must be one of T1-T12. */
interface SketchMcpToolDefinition extends McpToolDefinition {
	name: SketchToolName;
}

const SKETCH_ID = {
	type: 'string',
	description: 'Sketch id, from sketch_list or sketch_create.',
} as const;

const ELEMENT_IDS = {
	type: 'array',
	items: { type: 'string' },
	description: 'Excalidraw element ids, from sketch_read_scene.',
} as const;

/** Every element and summary the tools return carries the `sceneVersion` it was read at. */
const SCENE_VERSION_NOTE = 'Every response carries the sketch sceneVersion.';

/** Text other people wrote is screened before an agent sees it. */
const GATE_NOTE =
	'Text written by anyone other than you is screened first; text the screen did not clear is withheld and marked, never shown.';

/** Tools T1-T12 with their input schemas, exactly as spec section 4 lists them. */
export const SKETCH_MCP_TOOLS: ReadonlyArray<SketchMcpToolDefinition> = [
	{
		name: 'sketch_list',
		description:
			'List the Sketch Books your own Maestro agent owns: id, name, share state, collaborators online, and sceneVersion. ' +
			'You never see sketches that belong to other agents, regardless of which tab the user has focused.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'sketch_create',
		description:
			'Create a new Sketch Book owned by your agent. It opens in a background tab and is never shared. ' +
			'Returns the new sketch id.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Sketch name. Defaults to "Untitled sketch".' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_read_scene',
		description:
			'Read a sketch. format "summary" resolves bound text, lists arrows as "A -> B", and names frames and groups; ' +
			'format "elements" returns the Excalidraw elements. Every element carries author {id, kind, name}. ' +
			'Optionally limit the read to elementIds or to a bounding box. Freedraw points are capped. ' +
			GATE_NOTE +
			' ' +
			SCENE_VERSION_NOTE,
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				format: {
					type: 'string',
					enum: ['summary', 'elements'],
					description: 'Output format.',
				},
				elementIds: { ...ELEMENT_IDS, description: 'If set, read only these elements.' },
				bbox: {
					type: 'object',
					description: 'If set, read only elements that intersect this scene-coordinate box.',
					properties: {
						x: { type: 'number' },
						y: { type: 'number' },
						width: { type: 'number', minimum: 0 },
						height: { type: 'number', minimum: 0 },
					},
					required: ['x', 'y', 'width', 'height'],
					additionalProperties: false,
				},
			},
			required: ['sketchId', 'format'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_changes',
		description:
			'List the elements added, updated and deleted since a sceneVersion, each with lastEditedBy. ' +
			'Use it to follow what people drew since your last read. ' +
			GATE_NOTE +
			' ' +
			SCENE_VERSION_NOTE,
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				sinceVersion: {
					type: 'integer',
					minimum: 0,
					description: 'The sceneVersion of your last read.',
				},
			},
			required: ['sketchId', 'sinceVersion'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_add_elements',
		description:
			'Add elements with the Excalidraw element skeleton API (for example {type: "rectangle", x, y, width, height, label: {text}} ' +
			'or {type: "arrow", x, y, start: {id}, end: {id}}). ' +
			`At most ${SKETCH_MAX_ELEMENTS_PER_CALL} elements per call. Text you add is screened for secrets before it is drawn.`,
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				elements: {
					type: 'array',
					minItems: 1,
					maxItems: SKETCH_MAX_ELEMENTS_PER_CALL,
					description: 'Excalidraw element skeletons.',
					items: {
						type: 'object',
						properties: {
							type: {
								type: 'string',
								enum: ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'frame'],
								description: 'Element type.',
							},
							id: { type: 'string', description: 'Optional id, so later elements can bind to it.' },
						},
						required: ['type'],
						additionalProperties: true,
					},
				},
			},
			required: ['sketchId', 'elements'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_update_elements',
		description:
			'Change element properties. Each patch names an element id and the properties to set. ' +
			'Pass the baseVersion you read: when the element changed since, the patch is rejected and the current element is returned.',
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				patches: {
					type: 'array',
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Element id.' },
							baseVersion: {
								type: 'integer',
								minimum: 0,
								description: 'The element version you read.',
							},
						},
						required: ['id'],
						additionalProperties: true,
					},
				},
			},
			required: ['sketchId', 'patches'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_delete_elements',
		description: 'Delete elements by id (they become deleted tombstones, as in Excalidraw).',
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				ids: { ...ELEMENT_IDS, minItems: 1, description: 'Ids of the elements to delete.' },
			},
			required: ['sketchId', 'ids'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_from_mermaid',
		description:
			'Draw a Mermaid diagram (flowchart, sequence or class) on the sketch as editable Excalidraw elements. ' +
			'Text you add is screened for secrets before it is drawn.',
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				mermaid: { type: 'string', description: 'Mermaid diagram source.' },
			},
			required: ['sketchId', 'mermaid'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_screenshot',
		description:
			'Render the sketch, or some of its elements, to a PNG returned as an image. ' +
			'Elements whose text was withheld are left out of the render.',
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				elementIds: { ...ELEMENT_IDS, description: 'If set, render only these elements.' },
				scale: {
					type: 'number',
					exclusiveMinimum: 0,
					maximum: SKETCH_MAX_SCREENSHOT_SCALE,
					description: 'Render scale (default 1).',
				},
			},
			required: ['sketchId'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_export',
		description:
			'Export the sketch as png, svg or json to a path inside your working directory (paths outside it are refused). ' +
			'Elements whose text was withheld are left out.',
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				format: { type: 'string', enum: ['png', 'svg', 'json'], description: 'Export format.' },
				path: {
					type: 'string',
					description: 'Output file path, absolute or relative to your working directory.',
				},
			},
			required: ['sketchId', 'format', 'path'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_focus',
		description: "Scroll and zoom the people's view of the sketch to these elements.",
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				elementIds: { ...ELEMENT_IDS, minItems: 1, description: 'Ids of the elements to show.' },
			},
			required: ['sketchId', 'elementIds'],
			additionalProperties: false,
		},
	},
	{
		name: 'sketch_chat_post',
		description:
			"Post a message in the sketch's chat as the agent. Allowed during a turn the sketch started, or on a sketch that is not shared. " +
			'The text is screened for secrets before it is posted. At most 64 KB.',
		inputSchema: {
			type: 'object',
			properties: {
				sketchId: SKETCH_ID,
				text: {
					type: 'string',
					minLength: 1,
					maxLength: SKETCH_MAX_CHAT_POST_BYTES,
					description: 'Message text.',
				},
			},
			required: ['sketchId', 'text'],
			additionalProperties: false,
		},
	},
];

/**
 * The sketch `callTool(name, args)`, emitted into the script. Every advertised
 * tool goes to the bridge under its own name. A result that carries
 * `image: {data, mimeType}` (T9) comes back as MCP image content, followed by
 * the rest of the result as JSON text.
 */
const SKETCH_CALL_TOOL_SOURCE = String.raw`const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

async function callTool(name, args) {
  if (!TOOL_NAMES.has(name)) return null;
  const result = await bridgeCall(name, args);
  const image = result && typeof result === 'object' ? result.image : null;
  if (image && typeof image.data === 'string' && typeof image.mimeType === 'string') {
    const rest = Object.assign({}, result);
    delete rest.image;
    return {
      content: [
        { type: 'image', data: image.data, mimeType: image.mimeType },
        { type: 'text', text: JSON.stringify(rest, null, 2) },
      ],
    };
  }
  return jsonResult(result);
}`;

let cachedScript: string | null = null;

/** Returns the contents of the bundled `maestro-sketch` MCP server script. */
export function getSketchServerScript(): string {
	cachedScript ??= buildMcpStdioServerScript({
		title: 'Sketch Book',
		serverName: SKETCH_MCP_SERVER_NAME,
		bridgeLabel: 'sketch bridge',
		socketOverrideEnvVar: SKETCH_SOCKET_OVERRIDE_ENV_VAR,
		socketEnvVar: SKETCH_SOCKET_ENV_VAR,
		identityEnvVar: SKETCH_AGENT_ID_ENV_VAR,
		identityParam: 'agentId',
		tools: SKETCH_MCP_TOOLS,
		callToolSource: SKETCH_CALL_TOOL_SOURCE,
		// Writes convert skeletons and Mermaid in the renderer and screenshots
		// render a PNG there, so a call gets more room than a terminal read.
		rpcTimeoutMs: 30000,
	});
	return cachedScript;
}
