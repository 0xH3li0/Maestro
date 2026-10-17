import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function extractSessionIdFromFilename(filename: string): string | null {
	// Match pattern: rollout-YYYYMMDD_HHMMSS_MMM-UUID.jsonl or similar
	const match = filename.match(/rollout-[\d_]+-([a-f0-9-]+)\.jsonl$/i);
	if (match) {
		return match[1];
	}
	// Fallback: use filename without extension
	return filename.replace('.jsonl', '');
}

export async function listCodexSessionFiles(
	sessionsDir: string
): Promise<Array<{ filePath: string; filename: string }>> {
	const sessionFiles: Array<{ filePath: string; filename: string }> = [];

	try {
		await fs.access(sessionsDir);
	} catch {
		return [];
	}

	// Scan YYYY directories
	const years = await fs.readdir(sessionsDir);
	for (const year of years) {
		if (!/^\d{4}$/.test(year)) continue;

		const yearDir = path.join(sessionsDir, year);
		try {
			const yearStat = await fs.stat(yearDir);
			if (!yearStat.isDirectory()) continue;
		} catch {
			continue;
		}

		// Scan MM directories
		const months = await fs.readdir(yearDir);
		for (const month of months) {
			if (!/^\d{2}$/.test(month)) continue;

			const monthDir = path.join(yearDir, month);
			try {
				const monthStat = await fs.stat(monthDir);
				if (!monthStat.isDirectory()) continue;
			} catch {
				continue;
			}

			// Scan DD directories
			const days = await fs.readdir(monthDir);
			for (const day of days) {
				if (!/^\d{2}$/.test(day)) continue;

				const dayDir = path.join(monthDir, day);
				try {
					const dayStat = await fs.stat(dayDir);
					if (!dayStat.isDirectory()) continue;

					// Find session files
					const files = await fs.readdir(dayDir);
					for (const file of files) {
						if (file.endsWith('.jsonl')) {
							sessionFiles.push({
								filePath: path.join(dayDir, file),
								filename: file,
							});
						}
					}
				} catch {
					continue;
				}
			}
		}
	}

	return sessionFiles;
}

export async function findCodexSessionFile(
	sessionId: string,
	accountRoot: string
): Promise<string | null> {
	const allFiles = await listCodexSessionFiles(path.join(accountRoot, 'sessions'));

	for (const { filePath, filename } of allFiles) {
		const fileSessionId = extractSessionIdFromFilename(filename);
		if (fileSessionId === sessionId) {
			return filePath;
		}

		// Also check by reading first line for session ID
		try {
			const content = await fs.readFile(filePath, 'utf-8');
			const firstLine = content.split('\n')[0];
			if (firstLine) {
				const metadata = JSON.parse(firstLine) as { payload?: { id?: string }; id?: string };
				const metadataId = metadata?.payload?.id || metadata.id;
				if (metadataId === sessionId) {
					return filePath;
				}
			}
		} catch {
			// Skip files that can't be read
		}
	}

	return null;
}
