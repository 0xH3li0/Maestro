/**
 * Sealing a string with the key the operating system holds for this app.
 *
 * Electron's `safeStorage` encrypts with a key kept in the Keychain on macOS,
 * by DPAPI on Windows, and in a keyring on Linux. A file sealed with it cannot
 * be read by something that only reads files.
 *
 * `SealProvider` is the injectable form, so a store that seals its own file
 * can be unit-tested with a fake. `safeStorageSeal` is the production binding.
 *
 * Two things every caller must plan for:
 * - `safeStorage` works only after the app's `ready` event. Build a provider
 *   whenever you like, but do not call it before then.
 * - Encryption is not always there. A Linux machine with no keyring has none,
 *   and `available()` says so. A caller decides for itself what it does then.
 */

/** Seals and unseals a string with a key the OS holds. */
export interface SealProvider {
	available(): boolean;
	seal(plaintext: string): Buffer;
	unseal(blob: Buffer): string;
}

/** The part of Electron's `safeStorage` a seal needs. */
export interface SafeStorageLike {
	isEncryptionAvailable(): boolean;
	encryptString(s: string): Buffer;
	decryptString(b: Buffer): string;
}

/**
 * Production `SealProvider` over Electron `safeStorage`.
 *
 * `available()` never throws: a platform where the check itself fails has no
 * usable encryption, which is the same answer as "not available".
 */
export function safeStorageSeal(safeStorage: SafeStorageLike): SealProvider {
	return {
		available: () => {
			try {
				return safeStorage.isEncryptionAvailable();
			} catch {
				return false;
			}
		},
		seal: (plaintext) => safeStorage.encryptString(plaintext),
		unseal: (blob) => safeStorage.decryptString(blob),
	};
}
