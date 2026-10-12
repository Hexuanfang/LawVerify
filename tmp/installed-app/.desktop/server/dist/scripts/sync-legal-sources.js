import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_LEGAL_SOURCES } from '../legal-source-catalog.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = path.resolve(__dirname, '../../data/legal-source-snapshots');
const outputPath = path.join(outputDir, 'official-sources-latest.json');
function stripHtml(value) {
    return value
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function extractDocumentCount(sourceId, text) {
    if (sourceId === 'npc_flk') {
        const matched = text.match(/法律\s*(\d+).*?行政法规\s*(\d+).*?地方法规\s*(\d+).*?司法解释\s*(\d+)/s);
        if (!matched) {
            return null;
        }
        return {
            laws: Number(matched[1]),
            administrativeRegulations: Number(matched[2]),
            localRegulations: Number(matched[3]),
            judicialInterpretations: Number(matched[4]),
        };
    }
    if (sourceId === 'moj_xzfg') {
        const matched = text.match(/现行有效\s*(\d+)\s*部/);
        return matched ? { effectiveAdministrativeRegulations: Number(matched[1]) } : null;
    }
    if (sourceId === 'moj_regulations') {
        const matched = text.match(/现行有效\s*(\d+)\s*部/);
        return matched ? { effectiveRegulations: Number(matched[1]) } : null;
    }
    return null;
}
async function main() {
    const fetchedAt = new Date().toISOString();
    const items = await Promise.all(OFFICIAL_LEGAL_SOURCES.map(async (item) => {
        try {
            const response = await fetch(item.searchUrl, {
                headers: {
                    'User-Agent': 'LawVerify legal-source-sync/1.0',
                },
            });
            const html = await response.text();
            const text = stripHtml(html);
            return {
                ...item,
                status: response.ok ? 'ok' : 'http_error',
                httpStatus: response.status,
                fetchedAt,
                catalogStats: extractDocumentCount(item.id, text),
            };
        }
        catch (error) {
            return {
                ...item,
                status: 'network_error',
                fetchedAt,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }));
    const payload = {
        fetchedAt,
        items,
    };
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`官方法源目录已刷新：${outputPath}`);
}
void main();
