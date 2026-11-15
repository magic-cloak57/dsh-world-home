import { existsSync, readFileSync, rmSync } from 'node:fs';
import { durableWrite } from "./life/lifeStore.js";
import { parseSections } from "./life/messages.js";
/** Her persona in layers, each a `## 名字` section of `<world>/persona.md`, filled in the world console. */
export const PERSONA_LAYERS = ['名字', '一句话', '我在意什么', '我怎么说话', '说话的例子', '我不会做的事', '收尾'];
/** Missing or unreadable means not written yet: every layer empty. */
export function readPersona(file) {
    let sections = new Map();
    try {
        if (existsSync(file))
            sections = parseSections(readFileSync(file, 'utf8'), PERSONA_LAYERS);
    }
    catch { /* treated as not written */ }
    return Object.fromEntries(PERSONA_LAYERS.map(layer => [layer, sections.get(layer) ?? '']));
}
/** Only layers with text are kept; a persona with none removes the file. */
export function writePersona(file, persona) {
    const kept = PERSONA_LAYERS.flatMap(layer => { const text = persona[layer]?.trim(); return text ? [`## ${layer}\n${text}`] : []; });
    if (kept.length)
        durableWrite(file, `${kept.join('\n\n')}\n`);
    else
        rmSync(file, { force: true });
}
/** 《我是谁》的种子：每一层都留着，用她自己的口吻（第一人称）；空层跳过。 */
export function renderPersona(persona) {
    const kept = PERSONA_LAYERS.flatMap(layer => { const text = persona[layer]?.trim(); return text ? [`## ${layer}\n${text}`] : []; });
    return kept.length ? `# 我是谁\n\n${kept.join('\n\n')}\n` : '';
}
