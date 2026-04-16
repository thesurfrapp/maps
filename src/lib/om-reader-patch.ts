// Runtime monkey-patch of `@openmeteo/file-reader`'s `_iterateDataBlocks` so
// that index-block byte-range fetches happen in PARALLEL instead of one at a
// time. Upstream walks index blocks with `await _readDataBlock(...)` inside a
// while-loop — N index blocks × one RTT each = N × RTT, so with our R2 bucket
// in ENAM and a user in Europe/Brazil that's ~10 × 700 ms ≈ 7 s before any
// decode starts. The rewrite enumerates all index descriptors first (decoder
// math, no I/O), fires every `_readDataBlock` via `Promise.all`, and only then
// iterates data-reads using the pre-fetched bytes.
//
// Why monkey-patch instead of `patch-package`:
//   * No surgery on node_modules — trivial to revert (delete this import).
//   * Works across SSR / CSR / node-browser bundles — we don't need to track
//     4 copies of the file under `dist/{esm,cjs}/index{,.browser}.js`.
//   * Cheap to iterate if the decoder's pointer-state semantics surprise us.
//
// Safety: we only patch the prototype of `OmFileReader` and bail out if the
// method signature has changed (different arity or already swapped). If the
// patch fails to apply the app still boots with the upstream (serial) code.

import { OmFileReader } from '@openmeteo/file-reader';

type WasmLike = {
	_malloc: (n: number) => number;
	_free: (ptr: number) => void;
	setValue: (ptr: number, val: number, type: string) => void;
	getValue: (ptr: number, type: string) => number | bigint;
	om_decoder_next_index_read: (decoderPtr: number, indexReadPtr: number) => boolean;
	om_decoder_next_data_read: (
		decoderPtr: number,
		dataReadPtr: number,
		indexDataPtr: number,
		indexCount: bigint,
		errorPtr: number
	) => boolean;
	ERROR_OK: number;
};

type ReaderInternal = {
	wasm: WasmLike;
	newIndexRead: (decoderPtr: number) => number;
	newDataRead: (indexReadPtr: number) => number;
	_readDataBlock: (offset: number, size: number, signal: AbortSignal | undefined) => Promise<number>;
	_iterateDataBlocks: (
		decoderPtr: number,
		callback: (dataReadPtr: number, indexDataPtr: number, indexCount: bigint) => Promise<void>,
		signal: AbortSignal | undefined
	) => Promise<void>;
};

const throwIfAborted = (signal: AbortSignal | undefined) => {
	if (signal?.aborted) {
		const err = new Error('Aborted');
		err.name = 'AbortError';
		throw err;
	}
};

const proto = (OmFileReader as unknown as { prototype: ReaderInternal }).prototype;

// One-shot guard — hot-reload re-evaluates this module, which would otherwise
// double-patch and break the arity check on the second run.
const SYMBOL = Symbol.for('surfr.omFileReader.parallelIterate.v1');
const markedProto = proto as unknown as Record<symbol, boolean>;
if (!markedProto[SYMBOL]) {
	const original = proto._iterateDataBlocks;
	if (typeof original !== 'function' || original.length !== 3) {
		console.warn(
			'[om-reader-patch] skipped — _iterateDataBlocks signature changed; falling back to upstream'
		);
	} else {
		proto._iterateDataBlocks = async function (
			this: ReaderInternal,
			decoderPtr: number,
			callback: (dataReadPtr: number, indexDataPtr: number, indexCount: bigint) => Promise<void>,
			signal: AbortSignal | undefined
		): Promise<void> {
			const errorPtr = this.wasm._malloc(4);
			this.wasm.setValue(errorPtr, this.wasm.ERROR_OK, 'i32');

			// Pass 1 — enumerate all index-block descriptors. Pure decoder math; no I/O.
			const enumerationPtr = this.newIndexRead(decoderPtr);
			const descriptors: Array<{ offset: number; count: number }> = [];
			try {
				while (this.wasm.om_decoder_next_index_read(decoderPtr, enumerationPtr)) {
					throwIfAborted(signal);
					descriptors.push({
						offset: Number(this.wasm.getValue(enumerationPtr, 'i64') as bigint),
						count: Number(this.wasm.getValue(enumerationPtr + 8, 'i64') as bigint)
					});
				}
			} finally {
				this.wasm._free(enumerationPtr);
			}

			if (descriptors.length === 0) {
				this.wasm._free(errorPtr);
				return;
			}

			// Pass 2 — fire all index-block reads in parallel.
			let indexDataPtrs: number[];
			try {
				indexDataPtrs = await Promise.all(
					descriptors.map((d) => this._readDataBlock(d.offset, d.count, signal))
				);
			} catch (err) {
				this.wasm._free(errorPtr);
				throw err;
			}

			// Pass 3 — walk a fresh iterator in lockstep, dispatching the callback
			// with the pre-fetched block bytes.
			const indexReadPtr = this.newIndexRead(decoderPtr);
			let nextToFree = 0;
			try {
				for (let i = 0; i < descriptors.length; i++) {
					throwIfAborted(signal);
					if (!this.wasm.om_decoder_next_index_read(decoderPtr, indexReadPtr)) {
						throw new Error('index iterator ended early in second pass');
					}
					const indexCount = descriptors[i].count;
					const indexDataPtr = indexDataPtrs[i];
					const dataReadPtr = this.newDataRead(indexReadPtr);
					try {
						while (
							this.wasm.om_decoder_next_data_read(
								decoderPtr,
								dataReadPtr,
								indexDataPtr,
								BigInt(indexCount),
								errorPtr
							)
						) {
							throwIfAborted(signal);
							await callback(dataReadPtr, indexDataPtr, BigInt(indexCount));
						}
						const code = Number(this.wasm.getValue(errorPtr, 'i32') as number);
						if (code !== this.wasm.ERROR_OK) {
							throw new Error(`Data read iteration error: ${code}`);
						}
					} finally {
						this.wasm._free(dataReadPtr);
						this.wasm._free(indexDataPtr);
						nextToFree = i + 1;
					}
				}
			} finally {
				// Any index-block bytes we didn't reach still need freeing.
				for (let j = nextToFree; j < indexDataPtrs.length; j++) {
					try {
						this.wasm._free(indexDataPtrs[j]);
					} catch {
						/* noop */
					}
				}
				this.wasm._free(indexReadPtr);
				this.wasm._free(errorPtr);
			}
		};
		markedProto[SYMBOL] = true;
		void original;
	}
}
