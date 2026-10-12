import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getRuntimeRoot } from './config/paths.js';
let cachedSeed;
function cloneSeed(seed) {
    return JSON.parse(JSON.stringify(seed));
}
function getSeedFilePath() {
    return path.join(getRuntimeRoot(), 'seeds', 'default-law-library.json');
}
export function readBundledLawLibrarySeed() {
    if (cachedSeed !== undefined) {
        return cachedSeed ? cloneSeed(cachedSeed) : null;
    }
    const seedFilePath = getSeedFilePath();
    if (!existsSync(seedFilePath)) {
        cachedSeed = null;
        return null;
    }
    try {
        const raw = readFileSync(seedFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        cachedSeed = {
            generatedAt: parsed.generatedAt ?? new Date(0).toISOString(),
            sourceDir: parsed.sourceDir ?? '',
            knowledgeFiles: Array.isArray(parsed.knowledgeFiles) ? parsed.knowledgeFiles : [],
            knowledgeStatutes: Array.isArray(parsed.knowledgeStatutes) ? parsed.knowledgeStatutes : [],
            localRagIndex: {
                version: 1,
                files: parsed.localRagIndex?.files ?? {},
            },
        };
        return cloneSeed(cachedSeed);
    }
    catch {
        cachedSeed = null;
        return null;
    }
}
