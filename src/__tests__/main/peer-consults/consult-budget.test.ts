/**
 * @file consult-budget.test.ts
 * @description The consult budget counter against a real temp directory and
 * real fs: the count is the whole point, and so is what happens to it when the
 * file under it is missing, expired, locked or damaged.
 *
 * Every call passes `dataDir`. `MAESTRO_USER_DATA` is set in an agent's shell,
 * so the default directory is the LIVE one even though nothing here is Electron.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isConsultChainId } from '../../../shared/consultBudget';
import {
	CONSULT_BUDGET_FILE,
	CONSULT_CHAIN_TTL_MS,
	newConsultChainId,
	readConsultBudgetSpent,
	spendConsultBudget,
	sweepExpiredChains,
} from '../../../main/peer-consults/consult-budget';

let dataDir: string;
let filePath: string;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-budget-'));
	filePath = path.join(dataDir, CONSULT_BUDGET_FILE);
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

function readFile(): Record<string, { count: number; updatedAt: number }> {
	return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
		string,
		{ count: number; updatedAt: number }
	>;
}

describe('newConsultChainId', () => {
	it('mints a distinct, valid chain id each time', () => {
		const a = newConsultChainId();
		const b = newConsultChainId();

		expect(isConsultChainId(a)).toBe(true);
		expect(isConsultChainId(b)).toBe(true);
		expect(a).not.toBe(b);
	});
});

describe('spendConsultBudget', () => {
	it('counts each spend and persists the count', () => {
		expect(spendConsultBudget('chain-a', 3, { dataDir })).toEqual({ allowed: true, spent: 1 });
		expect(spendConsultBudget('chain-a', 3, { dataDir })).toEqual({ allowed: true, spent: 2 });
		expect(spendConsultBudget('chain-a', 3, { dataDir })).toEqual({ allowed: true, spent: 3 });

		expect(readFile()['chain-a'].count).toBe(3);
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(3);
	});

	it('refuses the spend past the limit without counting it', () => {
		spendConsultBudget('chain-a', 2, { dataDir });
		spendConsultBudget('chain-a', 2, { dataDir });

		expect(spendConsultBudget('chain-a', 2, { dataDir })).toEqual({ allowed: false, spent: 2 });
		expect(spendConsultBudget('chain-a', 2, { dataDir })).toEqual({ allowed: false, spent: 2 });
		expect(readFile()['chain-a'].count).toBe(2);
	});

	it('lets a raised limit take effect on the next spend', () => {
		spendConsultBudget('chain-a', 1, { dataDir });
		expect(spendConsultBudget('chain-a', 1, { dataDir }).allowed).toBe(false);

		expect(spendConsultBudget('chain-a', 2, { dataDir })).toEqual({ allowed: true, spent: 2 });
	});

	it('refuses everything at a limit of 0 and records no chain', () => {
		expect(spendConsultBudget('chain-a', 0, { dataDir })).toEqual({ allowed: false, spent: 0 });

		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('refuses when the limit is not a number', () => {
		expect(spendConsultBudget('chain-a', Number.NaN, { dataDir }).allowed).toBe(false);
	});

	it('keeps a separate budget for each chain', () => {
		spendConsultBudget('chain-a', 1, { dataDir });

		expect(spendConsultBudget('chain-a', 1, { dataDir }).allowed).toBe(false);
		expect(spendConsultBudget('chain-b', 1, { dataDir })).toEqual({ allowed: true, spent: 1 });
		expect(readFile()).toMatchObject({ 'chain-a': { count: 1 }, 'chain-b': { count: 1 } });
	});

	it('creates the data directory when it does not exist yet', () => {
		const fresh = path.join(dataDir, 'not', 'yet');

		expect(spendConsultBudget('chain-a', 1, { dataDir: fresh })).toEqual({
			allowed: true,
			spent: 1,
		});
	});

	it('releases its lock and leaves no temp file behind', () => {
		spendConsultBudget('chain-a', 1, { dataDir });

		expect(fs.readdirSync(dataDir)).toEqual([CONSULT_BUDGET_FILE]);
	});

	it('refuses an id that is not a chain id, and says so', () => {
		const result = spendConsultBudget('../escape', 5, { dataDir });

		expect(result.allowed).toBe(false);
		expect(result.problem).toContain('chain id');
		expect(fs.existsSync(filePath)).toBe(false);
	});

	describe('expiry', () => {
		const start = 1_000_000;

		it('sweeps a chain idle past the TTL when another chain spends', () => {
			spendConsultBudget('old-chain', 5, { dataDir, now: start });

			spendConsultBudget('new-chain', 5, { dataDir, now: start + CONSULT_CHAIN_TTL_MS + 1 });

			expect(Object.keys(readFile())).toEqual(['new-chain']);
		});

		it('keeps a chain that is exactly at the TTL', () => {
			spendConsultBudget('old-chain', 5, { dataDir, now: start });

			spendConsultBudget('new-chain', 5, { dataDir, now: start + CONSULT_CHAIN_TTL_MS });

			expect(Object.keys(readFile()).sort()).toEqual(['new-chain', 'old-chain']);
		});

		it('starts an expired chain over', () => {
			spendConsultBudget('chain-a', 1, { dataDir, now: start });
			const later = start + CONSULT_CHAIN_TTL_MS + 1;

			expect(readConsultBudgetSpent('chain-a', { dataDir, now: later })).toBe(0);
			expect(spendConsultBudget('chain-a', 1, { dataDir, now: later })).toEqual({
				allowed: true,
				spent: 1,
			});
		});

		it('counts a refused spend as activity, so a runaway cannot wait out the TTL', () => {
			spendConsultBudget('chain-a', 1, { dataDir, now: start });
			const almost = start + CONSULT_CHAIN_TTL_MS - 1;
			expect(spendConsultBudget('chain-a', 1, { dataDir, now: almost }).allowed).toBe(false);

			// Past the TTL measured from the first spend, but not from the refusal.
			expect(
				spendConsultBudget('chain-a', 1, { dataDir, now: start + CONSULT_CHAIN_TTL_MS + 1 })
			).toEqual({ allowed: false, spent: 1 });
		});
	});

	describe('a counter that cannot be used fails closed', () => {
		it.each([
			['truncated JSON', '{"chain-a": {"count": 1, "upd'],
			['an empty file', ''],
			['a JSON array', '[]'],
			['a JSON null', 'null'],
			['an entry with no count', '{"chain-a": {"updatedAt": 1}}'],
			['a negative count', '{"chain-a": {"count": -1, "updatedAt": 1}}'],
			['a fractional count', '{"chain-a": {"count": 1.5, "updatedAt": 1}}'],
			['a count that is a string', '{"chain-a": {"count": "1", "updatedAt": 1}}'],
			['an entry that is null', '{"chain-a": null}'],
			['a key that is not a chain id', '{"not a chain": {"count": 1, "updatedAt": 1}}'],
		])('refuses on %s and leaves the file as it was', (_name, content) => {
			fs.writeFileSync(filePath, content, 'utf-8');

			const result = spendConsultBudget('chain-b', 25, { dataDir });

			expect(result.allowed).toBe(false);
			expect(result.problem).toContain(filePath);
			// Never rewritten as an empty counter: that would be a free budget.
			expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
			expect(fs.readdirSync(dataDir)).toEqual([CONSULT_BUDGET_FILE]);
		});

		it('keeps refusing until the file is repaired, then counts again', () => {
			fs.writeFileSync(filePath, 'not json', 'utf-8');
			expect(spendConsultBudget('chain-a', 25, { dataDir }).allowed).toBe(false);
			expect(spendConsultBudget('chain-a', 25, { dataDir }).allowed).toBe(false);

			fs.rmSync(filePath);

			expect(spendConsultBudget('chain-a', 25, { dataDir })).toEqual({ allowed: true, spent: 1 });
		});

		it('refuses when the counter is a directory, not a file', () => {
			fs.mkdirSync(filePath);

			const result = spendConsultBudget('chain-a', 25, { dataDir });

			expect(result.allowed).toBe(false);
			expect(result.problem).toContain(filePath);
		});
	});
});

describe('readConsultBudgetSpent', () => {
	it('reads 0 for a chain that has not spent, and when no file exists', () => {
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(0);

		spendConsultBudget('chain-b', 5, { dataDir });
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(0);
	});

	it('does not spend', () => {
		spendConsultBudget('chain-a', 5, { dataDir });

		readConsultBudgetSpent('chain-a', { dataDir });
		readConsultBudgetSpent('chain-a', { dataDir });

		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBe(1);
	});

	it('reads null when the amount is not known', () => {
		expect(readConsultBudgetSpent('../escape', { dataDir })).toBeNull();

		fs.writeFileSync(filePath, 'not json', 'utf-8');
		expect(readConsultBudgetSpent('chain-a', { dataDir })).toBeNull();
	});
});

describe('sweepExpiredChains', () => {
	const start = 1_000_000;

	it('removes only the chains idle past the TTL', () => {
		spendConsultBudget('old-chain', 5, { dataDir, now: start });
		spendConsultBudget('live-chain', 5, { dataDir, now: start + CONSULT_CHAIN_TTL_MS });

		expect(sweepExpiredChains({ dataDir, now: start + CONSULT_CHAIN_TTL_MS + 1 })).toEqual({
			swept: 1,
		});
		expect(Object.keys(readFile())).toEqual(['live-chain']);
	});

	it('sweeps nothing and writes nothing when no chain has expired', () => {
		spendConsultBudget('chain-a', 5, { dataDir, now: start });
		const before = fs.statSync(filePath).mtimeMs;

		expect(sweepExpiredChains({ dataDir, now: start + 1 })).toEqual({ swept: 0 });
		expect(fs.statSync(filePath).mtimeMs).toBe(before);
	});

	it('is a no-op when there is no counter file', () => {
		expect(sweepExpiredChains({ dataDir })).toEqual({ swept: 0 });
		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('reports a corrupt counter and leaves it as it was', () => {
		fs.writeFileSync(filePath, 'not json', 'utf-8');

		const result = sweepExpiredChains({ dataDir });

		expect(result.swept).toBe(0);
		expect(result.problem).toContain(filePath);
		expect(fs.readFileSync(filePath, 'utf-8')).toBe('not json');
	});
});
