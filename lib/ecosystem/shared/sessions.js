import { conversationKey } from "./identity.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 群会话一天一个：只跨天换新；一天内不按大小/闲置换（上下文真到顶由 DSH 自己的压缩处理）。 */

/** 本地日期 + 时刻（跟家那边一个时区口径）。 */
function localStamp(date = new Date()) {
    return date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
}

export function createChannelSessions(deps) {
    const opening = new Map();
    const firstTitles = new Map();
    /** 每个群绑着哪条会话、上下文多大、是哪天开的：存在房间里，重启不丢。 */
    const stateFile = join(deps.roomDir, 'channel-rotate.json');
    let state = { sessions: {} };
    try {
        if (existsSync(stateFile))
            state = JSON.parse(readFileSync(stateFile, 'utf8')) || { sessions: {} };
    }
    catch { /* 坏了就当没有，下次写新的 */ }
    if (!state.sessions)
        state.sessions = {};
    // 2026-11-18：群会话 key 以前带账号（["qq","0","group",…]），现在只认群号。启动时把旧格式的群条目清掉，
    // 免得同一个群还挂着几条旧会话（它们不会再被用，但会出现在状态文件里）。
    for (const key of Object.keys(state.sessions)) {
        try {
            const parts = JSON.parse(key);
            if (Array.isArray(parts) && parts.length === 4 && parts[2] === 'group')
                delete state.sessions[key];
        }
        catch { /* 坏 key 不管 */ }
    }
    const save = () => {
        try { writeFileSync(stateFile, JSON.stringify(state, null, 1), 'utf8'); }
        catch { /* 记不住就下次再换 */ }
    };
    /** 会话 id → 它的 key，用来把 usage 记回对应那一行。 */
    const bySession = new Map();
    let stopped = false;
    const dispose = deps.ctx.on('session/event', (session, event) => {
        const key = bySession.get(session.id);
        if (!key || stopped)
            return;
        const entry = state.sessions[key];
        if (!entry || entry.sessionId !== session.id)
            return;
        if (event.type === 'assistant/message' && event.data.usage) {
            const usage = event.data.usage;
            const context = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
            if (context > (Number(entry.tokens) || 0)) {
                entry.tokens = context;
                entry.dirty = true;
            }
        }
        if (event.type === 'turn/end' && entry.dirty) {
            delete entry.dirty;
            save();
        }
        const title = firstTitles.get(session.id);
        if (event.type === 'turn/end' && title) {
            firstTitles.delete(session.id);
            void deps.host.rename(session.id, title).catch(error => deps.ctx.logger.error(error));
        }
    });
    async function resolve(identity) {
        if (stopped)
            throw new Error('Channel sessions stopped');
        const key = conversationKey(identity);
        const baseTitle = `${identity.channel === 'wechat' ? '微信' : identity.channel === 'qq' ? 'QQ' : identity.channel} · ${identity.conversationName || identity.conversationId}`;
        const workspace = await deps.host.workspace(deps.roomDir, deps.roomTitle);
        if (!workspace)
            throw new Error('群聊需要支持工作区的宿主');
        const bound = deps.store.channelSession(key);
        let entry = state.sessions[key];
        if (entry && entry.sessionId !== bound)
            entry = undefined;
        const now = Date.now();
        const stamp = localStamp();
        const today = stamp.slice(0, 10);
        // 一天一个群会话：只在跨天时换新；一天内不按大小/闲置换（2026-11-18 主人把 70k 安全阀也去掉了，
        // 上下文真到顶交给 DSH 自己的压缩）。
        const stale = Boolean(entry) && entry.day !== today;
        let id = bound;
        let agent = id && !deps.host.isArchived(id) ? await deps.host.resolveAgent(id) : undefined;
        let created = false;
        let day = entry?.day ?? today;
        // 没绑过、被归档了、或者够大且冷：都开一条新的。旧的不删，留着归档。
        if (!agent || stale) {
            if (stopped)
                throw new Error('Channel sessions stopped');
            day = stamp.slice(0, 10);
            id = await deps.host.createSession(deps.roomDir, deps.agentPreset, workspace.id);
            deps.store.bindChannelSession(key, id);
            state.sessions[key] = { sessionId: id, day, lastUsedAt: now, tokens: 0 };
            save();
            created = true;
            firstTitles.set(id, `${baseTitle} · ${today}`);
            agent = await deps.host.resolveAgent(id);
            if (!agent)
                throw new Error('新建群聊会话无法打开');
        }
        else {
            if (!workspace.sessionIds.includes(agent.id))
                await workspace.attachSession(agent.id);
            state.sessions[key] = { ...(entry ?? {}), sessionId: agent.id, day, lastUsedAt: now };
            save();
        }
        if (stopped)
            throw new Error('Channel sessions stopped');
        bySession.set(agent.id, key);
        // 2026-11-14 主人改的：群聊会话也要完全权限（群里接画画单要跑脚本、动 ComfyUI），
        // 每次打开都设一遍，复用的会话也一起升级。
        deps.host.setFullAccess(agent.session);
        // 新开的带日期标题；复用的不动它的名字。
        if (created)
            await deps.host.rename(agent.id, `${baseTitle} · ${today}`);
        return agent;
    }
    return {
        open(identity) {
            const key = conversationKey(identity);
            let pending = opening.get(key);
            if (!pending) {
                pending = resolve(identity).finally(() => opening.delete(key));
                opening.set(key, pending);
            }
            return pending;
        },
        stop() { stopped = true; dispose(); firstTitles.clear(); bySession.clear(); },
    };
}
