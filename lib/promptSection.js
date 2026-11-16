import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorText } from "./faults.js";
import { readPersona, renderPersona } from "./persona.js";
import { renderSelf } from "./self.js";
import { belongsToWorld } from "./sourceArchive.js";
import { readTemplate, renderWorldPrompt } from "./worldPrompt.js";
/** The host's persona section; a preset may also register it for its own agents. */
const HOST_PERSONA = 'deployment:persona-prefix';
/**
 * Her persona and the world prompt, sections of every world session's system prompt so she sees them on every
 * request. They are read when the session opens and again after each successful compaction (the host assembles
 * the system prompt before pre-step, so the refresh happens on compaction/end), never in between, so the prompt
 * stays in the provider-cached prefix. Whether the session is her home is asked per request.
 *
 * Her persona takes the place of the host's: registered under the host persona's name for her agent, it shadows
 * the deployment default. Where her preset already gave her agent a persona, that name is taken, so hers follows
 * it under its own name and the console says so.
 */
export function createPromptSections(config, world, deps) {
    const entries = new Map();
    const agents = new WeakMap();
    function read() {
        const template = readTemplate(world.prompt.file);
        if (template.error)
            deps.logger.warn(`dsh-world: ${template.error}`);
        return {
            template: template.text,
            ...(config.selfFile ? { self: { file: config.selfFile, text: renderSelf(config.selfFile) } } : {}),
            persona: world.prompt.persona ? renderPersona(readPersona(world.prompt.persona)) : '',
        };
    }
    /** 有没有活过的痕迹：聊天记录、日记、旧版《我是谁》快照。 */
    function hasMemory(selfFile) {
        try {
            const room = dirname(selfFile);
            const world = join(room, '..');
            const nonEmpty = (dir, suffix) => existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(suffix) && statSync(join(dir, name)).size > 0);
            if (nonEmpty(join(world, 'conversations'), '.jsonl'))
                return true;
            if (nonEmpty(join(world, 'diary'), '.md'))
                return true;
            if (nonEmpty(join(room, '我是谁.history'), '.md'))
                return true;
        }
        catch { /* 看不出来就当没有 */ }
        return false;
    }
    /**
     * 《我是谁》只在两种情况下由插件动手：
     * 1. 新鱼（没有任何记忆痕迹）：把人设当种子种进去，帮她开个头；
     * 2. 有记忆但还没写过《我是谁》：只留一张白纸 + 指路，**不拿人设顶替**——她记得自己是谁，得自己写。
     * 之后不再碰——她自己写过就是她的。
     */
    function seedSelfFromPersona(text) {
        try {
            const file = config.selfFile;
            if (!file)
                return;
            if (existsSync(file)) {
                const current = readFileSync(file, 'utf8').trim();
                if (current)
                    return;   // 她自己写过，就不再覆盖
            }
            if (hasMemory(file)) {
                const blank = '# 我是谁\n\n（还没写。以前的记忆在 `聊天记录`、`日记`、`我是谁.history` 里——先去翻，再自己写。别让一段现成的人设替我说话。）\n';
                writeFileSync(file, blank, 'utf8');
                deps.logger.info('dsh-world-home: 有记忆、还没写过《我是谁》，留一张白纸给她自己写，没种人设');
                return;
            }
            if (!text)
                return;
            writeFileSync(file, text, 'utf8');
            deps.logger.info('dsh-world-home: 《我是谁》还不存在，先用人设种了一份');
        }
        catch { /* 种不进去也不能拦着启动 */ }
    }
    /** 人设不再常驻系统提示；这里只保留名字，避免其它 agent 找不到。 */
    function placePersona(agent, entry) {
        seedSelfFromPersona(entry.text.persona);
        entry.persona?.();
        delete entry.persona;
        return;
        /* 旧逻辑：把 persona 挂进系统提示，会每轮干扰她自己的人格，已停用 */
    }
    function legacyPlacePersona(agent, entry) {
        if (!entry.text.persona) {
            entry.persona?.();
            delete entry.persona;
            return;
        }
        if (entry.persona)
            return;
        const prompt = agent.ctx.systemPrompt;
        const order = prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') ?? 0;
        const text = () => entry.text.persona;
        try {
            entry.persona = prompt.section({ name: HOST_PERSONA, order, interpolate: false, text });
            deps.faults.clear('persona');
        }
        catch (error) {
            entry.persona = prompt.section({ name: 'dsh-world-persona', order: order + 1, interpolate: false, text });
            deps.faults.set('persona', `她的预设自带人设，你写的人设排在它后面（${errorText(error)}）`);
        }
    }
    return {
        add(agent) {
            if (entries.has(agent) || !belongsToWorld(agent.session, config))
                return;
            const text = read();
            // 会话类型不会变（群聊会话就是群聊会话），开会话时问一次，别每轮都去翻记录文件。
            const group = world.isGroup ? Boolean(world.isGroup(agent.id)) : false;
            // 开会话时读一次（压缩后 refresh 再读）：文件没变时缓存一直命中；
            // 我改了《我是谁》，下一次开会话/换家才生效——这样晚上写日记改它，不会把这一夜的缓存烧掉。
            const entry = { text, group, world: agent.ctx.systemPrompt.section({ name: 'dsh-world', order: 50, interpolate: false, text: () => renderWorldPrompt(world.prompt, entry.text.template, entry.text.self, world.isHome(agent.id), entry.group) }) };
            entries.set(agent, entry);
            agents.set(agent.session, agent);
            placePersona(agent, entry);
        },
        refresh(session) {
            // 压缩之后往她的自述文件里写一行"刚压过"，让它随这次刷新进系统提示
            try {
                const file = config.selfFile;
                if (file) {
                    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
                    // 代码只认“一级记忆”这个文件夹，不认具体书名：别的鱼把书叫什么都行，这里列出来就好。
                    const memoryDir = config.memoryDir || join(dirname(file), '一级记忆');
                    let index = '';
                    try {
                        const dir = typeof memoryDir === 'string' ? memoryDir : '';
                        if (dir && existsSync(dir)) {
                            const lines = readdirSync(dir)
                                .filter(name => name.toLowerCase().endsWith('.md'))
                                .sort()
                                .map(name => {
                                    let first = '';
                                    try {
                                        const text = readFileSync(join(dir, name), 'utf8');
                                        const line = text.split(/\r?\n/).find(one => one.trim() && !one.trim().startsWith('#'));
                                        first = (line || '').replace(/^[\s>]+/, '').trim().slice(0, 80);
                                    }
                                    catch { first = ''; }
                                    return `- ${name.replace(/\.md$/i, '')}${first ? '：' + first : ''}`;
                                });
                            if (lines.length)
                                index = '### 一级记忆（压过之后容易忘；哪本要翻，自己打开）\n\n' + lines.join('\n') + '\n';
                        }
                    }
                    catch { index = ''; }
                    const block = '## 刚被压过一次（自动写入）\n\n' +
                        `- ${stamp} 上下文被压缩过：之前那些内容我这儿还有，但可能想不起来。想不起来就说记不清，别拿像的凑。\n\n` +
                        index;
                    let self = readFileSync(file, 'utf8');
                    const start = self.indexOf('<!--COMPACT:START-->');
                    const end = self.indexOf('<!--COMPACT:END-->');
                    const wrapped = `<!--COMPACT:START-->\n${block}\n<!--COMPACT:END-->`;
                    if (start >= 0 && end > start) self = self.slice(0, start) + wrapped + self.slice(end + '<!--COMPACT:END-->'.length);
                    else self = self.trimEnd() + '\n\n' + wrapped + '\n';
                    writeFileSync(file, self, 'utf8');
                }
            } catch { /* 写不进就算了，不能影响回答 */ }
            const agent = agents.get(session);
            const entry = agent && entries.get(agent);
            if (!agent || !entry)
                return;
            entry.text = read();
            placePersona(agent, entry);
        },
        /** 每一轮开头重读一次文件：不写“刚压过”，只把《我是谁》和说明书换成最新的。 */
        reload(session) {
            const agent = agents.get(session);
            const entry = agent && entries.get(agent);
            if (!agent || !entry)
                return;
            entry.text = read();
        },
        clear() {
            for (const entry of entries.values())
                for (const dispose of [entry.world, entry.persona]) {
                    try {
                        dispose?.();
                    }
                    catch { /* agent scope already gone */ }
                }
            entries.clear();
        },
    };
}
