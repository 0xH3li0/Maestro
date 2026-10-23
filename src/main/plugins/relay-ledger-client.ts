import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { RelayLedgerLimits } from './relay-ledger';
/** Serialized, bounded host-private worker transport. No synchronous fallback. */
export class RelayLedgerClient {
	private worker?: Worker;
	private seq = 0;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private idle?: ReturnType<typeof setTimeout>;
	constructor(
		private readonly baseDir: string,
		private readonly limits?: Partial<RelayLedgerLimits>,
		private readonly script = path.join(__dirname, 'relay-ledger-worker.js')
	) {}
	private call<T>(method: string, ...args: unknown[]): Promise<T> {
		if (this.pending.size >= 128)
			return Promise.reject(Error('Relay receipt queue capacity reached'));
		if (this.idle) clearTimeout(this.idle);
		if (!this.worker) {
			const worker = new Worker(this.script, {
				workerData: { baseDir: this.baseDir, limits: this.limits },
			});
			this.worker = worker;
			const fail = () => {
				if (this.worker !== worker) return;
				this.worker = undefined;
				for (const item of this.pending.values())
					item.reject(Error('Relay receipt worker unavailable; execution state retained'));
				this.pending.clear();
			};
			worker.on('error', fail);
			worker.on('exit', fail);
			worker.on('message', (response: { id: number; value: unknown; error?: string }) => {
				const item = this.pending.get(response.id);
				if (!item) return;
				this.pending.delete(response.id);
				if (response.error) item.reject(Error(response.error));
				else item.resolve(response.value);
				if (!this.pending.size)
					this.idle = setTimeout(() => {
						if (this.worker === worker) {
							this.worker = undefined;
							void worker.terminate();
						}
					}, 30000).unref();
			});
			worker.unref();
		}
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			try {
				this.worker!.postMessage({ id, method, args });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	async dispose(): Promise<void> {
		if (this.idle) clearTimeout(this.idle);
		const worker = this.worker;
		this.worker = undefined;
		for (const item of this.pending.values())
			item.reject(Error('Relay receipt worker closed; execution state retained'));
		this.pending.clear();
		await worker?.terminate();
	}
	get(key: string): Promise<string | null> {
		return this.call('get', key);
	}
	set(key: string, value: string): Promise<void> {
		return this.call('set', key, value);
	}
	reserveTurn(key: string, value: string, mappingKey?: string, mapping?: string): Promise<void> {
		return this.call('reserveTurn', key, value, mappingKey, mapping);
	}
	finishTurn(
		receiptKey: string,
		receipt: string,
		mappingKey: string,
		mapping: string
	): Promise<void> {
		return this.call('finishTurn', receiptKey, receipt, mappingKey, mapping);
	}
	mappingKeys(): Promise<string[]> {
		return this.call('mappingKeys');
	}
	assertProviderAvailable(agent: string, provider: string, conversation: string): Promise<void> {
		return this.call('assertProviderAvailable', agent, provider, conversation);
	}
	settleTurn(key: string, providerId?: string): Promise<void> {
		return this.call('settleTurn', key, providerId);
	}
	deletePending(key: string): Promise<void> {
		return this.call('deletePending', key);
	}
	purgeMappings(): Promise<void> {
		return this.call('purgeMappings');
	}
}
