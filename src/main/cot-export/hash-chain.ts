/**
 * Chain of thought export: the hash chain.
 *
 * Every record carries the hash of the record before it. A log that was
 * edited, reordered, or cut in the middle no longer adds up, and a reader can
 * find where.
 *
 * This module is the one definition of a record's hash:
 *
 *   hash = SHA-256( prevHash + "\n" + canonicalJson(record without `hash`) )
 *
 * The input is hashed as UTF-8 and the result is 64 lowercase hex characters.
 * `prevHash` is inside the record as well as in front of it, as the format
 * says (see `CotRecordBase`).
 *
 * The writer seals with this module and the verifier recomputes with it, so
 * the two cannot disagree about what a hash covers.
 *
 * The hash follows the record's VALUE, not the text of its line.
 * `canonicalJson` sorts keys, so a line can be written in any key order and
 * read back to the same hash.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import { createHash } from 'crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import type { CotRecord, CotRecordBase, CotUnsealedRecord } from '../../shared/cotExport/types';

/**
 * SHA-256 as 64 lowercase hex characters: the form of every hash in this
 * format. A string is hashed as UTF-8.
 */
export function sha256Hex(data: string | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * The hash `record` should carry, worked out from every field but `hash`.
 *
 * A record is intact when this equals `record.hash`. The stored `hash` is not
 * part of the input, so a record whose `hash` was changed still gives the
 * hash it was sealed with, and the difference shows.
 */
export function recomputeHash(record: CotRecord): string {
	const { hash: _stored, ...withoutHash } = record;
	return sha256Hex(`${record.prevHash}\n${canonicalJson(withoutHash)}`);
}

/**
 * Links `unsealed` after the record whose hash is `prevHash` and returns the
 * complete record. For the first record of a chain, pass `COT_GENESIS_HASH`.
 * The input is not changed.
 *
 * It throws when the record holds a value `canonicalJson` refuses, for
 * example a non-finite number in a usage figure. A caller that must not lose
 * the turn over one bad record has to catch that.
 */
export function sealRecord(unsealed: CotUnsealedRecord, prevHash: string): CotRecord {
	// `hash` comes from the same function a reader checks it with, so a record
	// sealed here always verifies. That holds even when the input still carries
	// the hash fields of an earlier sealing: both are replaced, and
	// `recomputeHash` never reads the stored `hash`.
	const linked: CotRecord = { ...unsealed, prevHash, hash: '' };
	return { ...linked, hash: recomputeHash(linked) };
}

/**
 * Whether `record` follows the record whose hash is `expectedPrev`. For the
 * first record of a chain, pass `COT_GENESIS_HASH`.
 *
 * This checks the link and nothing else. Whether the record itself was edited
 * is a separate question: compare `recomputeHash(record)` with `record.hash`.
 * An edited record that was sealed again passes that check and fails this one
 * at the record after it.
 */
export function isLinked(record: Pick<CotRecordBase, 'prevHash'>, expectedPrev: string): boolean {
	return record.prevHash === expectedPrev;
}
