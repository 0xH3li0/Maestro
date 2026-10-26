/**
 * @file sketch-mcp-server-script.test.ts
 *
 * The generated `maestro-sketch` MCP server script. Properties worth
 * protecting:
 *
 *   - **The advertised tools are T1-T12** (spec section 4), in spec order, and
 *     match the names the bridge routes, so no tool is advertised that the
 *     bridge refuses and none is routed that the agent cannot see.
 *   - **Required inputs match the spec table**: every tool that names a sketch
 *     requires `sketchId`, plus its own required fields; optional fields stay
 *     optional; closed schemas reject stray top-level fields.
 *   - **The caps the spec names are in the schema** (500 elements per add,
 *     64 KB per chat post).
 *   - **The emitted script is wired to Sketch, not Coworking**: server name,
 *     socket env precedence, and the `agentId` hello param.
 */

import { describe, it, expect } from 'vitest';

import {
	SKETCH_MAX_CHAT_POST_BYTES,
	SKETCH_MAX_ELEMENTS_PER_CALL,
	SKETCH_MCP_TOOLS,
	getSketchServerScript,
} from '../../../main/sketch/sketch-mcp-server-script';
import { SKETCH_TOOL_NAMES } from '../../../main/sketch/sketch-mcp-types';

interface Schema {
	type?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: boolean;
	enum?: string[];
	items?: Schema;
	minItems?: number;
	maxItems?: number;
	maxLength?: number;
}

function schemaOf(name: string): Schema {
	const tool = SKETCH_MCP_TOOLS.find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} is not advertised`);
	return tool.inputSchema as Schema;
}

/** Required top-level inputs per tool, from the spec section 4 table. */
const REQUIRED_INPUTS: Record<string, string[]> = {
	sketch_list: [],
	sketch_create: [],
	sketch_read_scene: ['sketchId', 'format'],
	sketch_changes: ['sketchId', 'sinceVersion'],
	sketch_add_elements: ['sketchId', 'elements'],
	sketch_update_elements: ['sketchId', 'patches'],
	sketch_delete_elements: ['sketchId', 'ids'],
	sketch_from_mermaid: ['sketchId', 'mermaid'],
	sketch_screenshot: ['sketchId'],
	sketch_export: ['sketchId', 'format', 'path'],
	sketch_focus: ['sketchId', 'elementIds'],
	sketch_chat_post: ['sketchId', 'text'],
};

/** Optional top-level inputs per tool, from the same table. */
const OPTIONAL_INPUTS: Record<string, string[]> = {
	sketch_create: ['name'],
	sketch_read_scene: ['elementIds', 'bbox'],
	sketch_screenshot: ['elementIds', 'scale'],
};

describe('maestro-sketch advertised tools', () => {
	it('advertises exactly T1-T12, in spec order, matching the bridge routes', () => {
		expect(SKETCH_MCP_TOOLS.map((t) => t.name)).toEqual([...SKETCH_TOOL_NAMES]);
		expect(SKETCH_MCP_TOOLS.map((t) => t.name)).toEqual([
			'sketch_list',
			'sketch_create',
			'sketch_read_scene',
			'sketch_changes',
			'sketch_add_elements',
			'sketch_update_elements',
			'sketch_delete_elements',
			'sketch_from_mermaid',
			'sketch_screenshot',
			'sketch_export',
			'sketch_focus',
			'sketch_chat_post',
		]);
	});

	it.each(Object.entries(REQUIRED_INPUTS))('%s requires exactly %j', (name, required) => {
		const schema = schemaOf(name);
		expect(schema.type).toBe('object');
		expect([...(schema.required ?? [])].sort()).toEqual([...required].sort());
		for (const field of required) expect(schema.properties).toHaveProperty(field);
	});

	it('keeps the optional inputs optional', () => {
		for (const [name, optional] of Object.entries(OPTIONAL_INPUTS)) {
			const schema = schemaOf(name);
			for (const field of optional) {
				expect(schema.properties).toHaveProperty(field);
				expect(schema.required ?? []).not.toContain(field);
			}
		}
	});

	it('closes every top-level schema to stray fields and gives every tool a description', () => {
		for (const tool of SKETCH_MCP_TOOLS) {
			expect((tool.inputSchema as Schema).additionalProperties).toBe(false);
			expect(tool.description.length).toBeGreaterThan(0);
		}
	});

	it('uses the spec enums for read and export formats', () => {
		expect(schemaOf('sketch_read_scene').properties?.format.enum).toEqual(['summary', 'elements']);
		expect(schemaOf('sketch_export').properties?.format.enum).toEqual(['png', 'svg', 'json']);
	});

	it('caps an add at 500 elements and a chat post at 64 KB', () => {
		expect(SKETCH_MAX_ELEMENTS_PER_CALL).toBe(500);
		expect(schemaOf('sketch_add_elements').properties?.elements.maxItems).toBe(500);
		expect(SKETCH_MAX_CHAT_POST_BYTES).toBe(64 * 1024);
		expect(schemaOf('sketch_chat_post').properties?.text.maxLength).toBe(64 * 1024);
	});

	it('requires an id on every update patch and a type on every skeleton', () => {
		expect(schemaOf('sketch_update_elements').properties?.patches.items?.required).toEqual(['id']);
		expect(schemaOf('sketch_add_elements').properties?.elements.items?.required).toEqual(['type']);
	});
});

describe('getSketchServerScript', () => {
	const script = getSketchServerScript();

	it('names itself maestro-sketch and advertises the same tool list', () => {
		expect(script).toContain('const SERVER_INFO = { name: "maestro-sketch", version: \'1.0.0\' };');
		for (const name of SKETCH_TOOL_NAMES) expect(script).toContain(`"name": "${name}"`);
		expect(script).not.toContain('maestro-coworking');
	});

	it('prefers the per-spawn socket override over the config socket', () => {
		expect(script).toContain(
			'process.env.MAESTRO_SKETCH_SOCKET_OVERRIDE || process.env.MAESTRO_SKETCH_SOCKET'
		);
	});

	it('sends the injected agent id as `agentId` in hello', () => {
		expect(script).toContain('const OWNER_ID = process.env.MAESTRO_SKETCH_AGENT_ID || null;');
		expect(script).toContain('if (OWNER_ID) params.agentId = OWNER_ID;');
	});

	it('is valid JavaScript', () => {
		// Strip the shebang line, then compile without running.
		const body = script.replace(/^#!.*\n/, '');
		expect(() => new Function('require', 'process', body)).not.toThrow();
	});
});
