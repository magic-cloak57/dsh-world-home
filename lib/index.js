import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { biliRoute, createBili } from "../bili/index.js";
import { createBridge } from "./ecosystem/bridge/bridge.js";
import { bridgeRoute } from "./ecosystem/bridge/route.js";
import { consoleRoute } from "./console/routes.js";
import { consoleSources } from "./console/snapshot.js";
import { errorText, Faults } from "./faults.js";
import { hostLife } from "./life/host.js";
import { createLifeStore, durableWrite } from "./life/lifeStore.js";
import { addClockMinutes, createSchedule } from "./schedule.js";
import { toastSupported, windowsToast } from "./life/notify.js";
import { createLifeRuntime } from "./life/runtime.js";
import { createOutlet } from "./ecosystem/shared/outlets.js";
import { readPersona, writePersona } from "./persona.js";
import { qqRoute } from "./ecosystem/qq/route.js";
import { createConsoleDoors } from "./ecosystem/qq/panel.js";
import { createWorldRuntime } from "./runtime.js";
import { createArchiveStore } from "./store.js";
import { DEFAULT_TEMPLATE_FILE, roomTitle, worldNames } from "./worldPrompt.js";
import { createWorldSwitch } from "./worldSwitch.js";
import { createWechatModule } from "./ecosystem/wechat/index.js";
import { createWechatRecorder } from "./ecosystem/wechat/archive.js";
import { createAdapterSupervisor } from "./ecosystem/wechat/supervisor.js";
import { createChannelSessions } from "./ecosystem/shared/sessions.js";
import { createArchiveSelection } from "./archiveSelection.js";
import { createMemory } from "./memory.js";
import { createMemoryStore } from "./memoryStore.js";
import { belongsToWorld } from "./sourceArchive.js";
export { createWorldRuntime } from "./runtime.js";
export const name = 'dsh-world-home';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
// One companion per profile is the usual case, so it works as installed: the standard preset, a world named
// default and the system time zone, with the life line on (it needs the desktop host's services and stays off without them).
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
    worldId: z.string().default('default'), worldRoot: z.string().default(''), agentPreset: z.string().default('standard'), timeZone: z.string().default(systemTimeZone),
    companionName: z.string(), partnerName: z.string(),
    archiveScope: z.union([z.const('home').description('仅家会话'), z.const('workspace').description('家所在工作区'), z.transform(z.const('world').hidden(), () => 'workspace').hidden()]).default('workspace').description('记忆归档范围，修改后重启生效'),
    life: z.boolean().default(true), diaryDir: z.string(), fallbackWakeTime: z.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
    selfFile: z.string(), worldPromptFile: z.string(), alarmTemplateFile: z.string(), personaFile: z.string(),
    // Where her words go outside DSH; no app is known by name (see README for the push body).
    outlets: z.array(z.object({ name: z.string().required(), url: z.string(), urlFile: z.string(), path: z.string(), kinds: z.array(z.union([z.const('reply'), z.const('busy'), z.const('reach')])) })).default([]),
    // A local app may hand her partner's words to her home through POST /dsh-world/bridge/say.
    bridge: z.boolean().default(false),
    qqNative: z.object({
        enabled: z.boolean().default(false),
        wsUrl: z.string().default('ws://127.0.0.1:3003'),
        accessToken: z.string().default(''),
        allowPrivate: z.array(z.string()).default([]),
        allowGroups: z.array(z.string()).default([]),
        autoReply: z.boolean().default(true),
        contextMessages: z.number().default(6),
        // 群里什么时候接话。量出来的事实是：不做这个判断的话，群里每句都会让她跑完一轮、还往群里冒一条
        // （她自己会在话里写「这句不接」，但那句话本身也发到群里了）。默认只接被叫到的。
        groupTrigger: z.union([z.const('mention').description('只接被叫到的（被 @ / 被引用她的话 / 命中关键词）'), z.const('all').description('每句都接')]).default('mention'),
        groupKeywords: z.array(z.string()).default([]),
        // SnowLuma 装在哪：控制台那扇门要去它的 config/runtime.json 拿地址与端口。空着就按 D:\SnowLuma、
        // C:\SnowLuma、~/SnowLuma 挨个认（认「里面有 config/runtime.json」这一条）。
        snowlumaHome: z.string().default(''),
        // 谁和她的家会话共用一个入口。'owner'（默认）＝群各自独立、私聊用她的家；'all'＝都用她的家；
        // 'none'＝谁都不绑，每个入口各建一个 —— 开发测试 QQ 的时候填 none，回合就不会走进步话生活的家里。
        bindHomeSession: z.union([z.const('owner').description('群各自独立，私聊用她的家会话'), z.const('all').description('都用她的家会话'), z.const('none').description('谁都不绑，每个入口各建一个'), z.const('')]).default('owner'),
        // 阳台：给这台机器上别的程序留的一条线。口令空着就由插件自己生成一条并存在世界目录里。
        bridge: z.object({
            port: z.number().default(0),
            token: z.string().default(''),
            title: z.string().default('阳台'),
            contextMessages: z.number().default(6),
        }).default({ port: 0, token: '', title: '阳台', contextMessages: 6 }),
    }).description('QQ 直接连 OneBot：不经过 qq-bridge 进程，会话与状态都由这个插件自己管'),
    wechat: z.boolean().default(false),
    wechatAdapter: z.object({ python: z.string(), config: z.string() }).description('随微信模块启动和停止 Windows 适配器；写上即视为允许它发送消息'),
    // 刷B站：原来是单独一个插件（dsh-bili-ximeng），2026-11-04 并进来，功能一样、只是叫醒走家里的阳台。
    // 这一段是种子配置；面板上改的写进房间的 B站\config.json，那份覆盖这里。开关不在这儿，跟微信/QQ 一样记在 world.json。
    bili: z.object({
        dailyTime: z.string().default('21:30'),
        keywords: z.string().default('单机游戏,独立游戏,嘉然,明前奶绿,大肥鱼二创,深海,沙盒游戏,做饭'),
        ownerUid: z.string().default(''),
        stateDir: z.string().default(''),
        pythonPath: z.string().default('D:\\AstrBot\\venv\\Scripts\\python.exe'),
    }).default({}).description('刷B站：每天到点取料、写日报、用阳台把她叫醒去挑'),
    toast: z.boolean().default(true),
    // The console and the bridge answer only this machine by name, plus these (a LAN address or domain behind a proxy).
    allowedHosts: z.array(z.string()).default([]),
});
/** 家的位置记在 `<world>/home.json`：配置丢了、或者旧路径还是 junction，都能认回来。 */
function readHomeRecord(dir) {
    try {
        // PowerShell 5.1 写的 UTF-8 带 BOM，JSON.parse 见了 BOM 会直接抛，所以先剥掉
        const text = String(readFileSync(join(dir, 'home.json'), 'utf8')).replace(/^\uFEFF/, '');
        const rec = JSON.parse(text);
        return typeof rec?.world === 'string' ? rec.world : '';
    }
    catch { return ''; }
}
function hasHome(dir) {
    try {
        if (!dir || !existsSync(dir))
            return false;
        return statSync(dir).isDirectory() && existsSync(join(dir, 'world.json'));
    }
    catch { return false; }
}
function writeHomeRecord(dir) {
    try {
        if (!hasHome(dir))
            return;
        if (readHomeRecord(dir) === dir)
            return;
        writeFileSync(join(dir, 'home.json'), JSON.stringify({ world: dir, at: new Date().toISOString() }, null, 2), 'utf8');
    }
    catch { /* 记不住也不能拦着启动 */ }
}
/** 面板上选的「家放在哪」记在这里：家还没找到的时候，这条不能记在家里。 */
function homeOverridePath(dshHome) {
    return join(dshHome, 'storages', 'dsh-world-home.home.json');
}
function readHomeOverride(dshHome) {
    try {
        const rec = JSON.parse(String(readFileSync(homeOverridePath(dshHome), 'utf8')).replace(/^\uFEFF/, ''));
        return typeof rec?.worldRoot === 'string' ? rec.worldRoot : '';
    }
    catch { return ''; }
}
function writeHomeOverride(dshHome, worldRoot) {
    const file = homeOverridePath(dshHome);
    if (!worldRoot) {
        try { rmSync(file, { force: true }); } catch { }
        return;
    }
    mkdirSync(join(dshHome, 'storages'), { recursive: true });
    writeFileSync(file, JSON.stringify({ worldRoot, at: new Date().toISOString() }, null, 2), 'utf8');
}
/** 真正在用的家根目录：面板选的 > 配置文件里的 > 空（就用默认位置）。 */
function homeRootOf(dshHome, config) {
    return readHomeOverride(dshHome) || config.worldRoot || '';
}
/** 面板上「家放在哪」要显示的东西：现在在哪、从哪来的、旧路径是不是 junction。 */
function describeHome(dshHome, config, worldDir) {
    const legacy = join(dshHome, 'worlds', config.worldId);
    let legacyJunction = '';
    try {
        if (lstatSync(legacy).isSymbolicLink())
            legacyJunction = readlinkSync(legacy);
    }
    catch { }
    return { dir: worldDir, worldRoot: config.worldRoot || '', override: readHomeOverride(dshHome), legacyJunction, defaultDir: legacy };
}
/**
 * 家的位置：面板选的优先，其次配置的 worldRoot；那儿还没有家、默认位置有家时，**跟着 home.json 的记录走**；
 * 再不行才用默认位置。只有两边都没有家才当新家——绝不因为路径对不上就在别处开一个空家。
 */
function pickWorldDir(dshHome, config) {
    const configured = homeRootOf(dshHome, config) ? join(homeRootOf(dshHome, config), config.worldId) : '';
    const fallback = join(dshHome, 'worlds', config.worldId);
    if (configured && hasHome(configured))
        return { dir: configured, note: '' };
    if (hasHome(fallback)) {
        const recorded = readHomeRecord(fallback);
        if (recorded && recorded !== fallback && hasHome(recorded))
            return { dir: recorded, note: `家记着自己在 ${recorded}，跟着它走（配置里写的是 ${configured || '未设'}）` };
        return {
            dir: fallback,
            note: configured && configured !== fallback
                ? `配置里的家（${configured}）还没有，先用原来的 ${fallback}；要搬先跑迁移脚本，别让它开个空家`
                : '',
        };
    }
    return { dir: configured || fallback, note: '' };
}
/**
 * Her world runs only after her partner presses start in the world console, and stops when they press stop:
 * memory block, persona, world prompt, archive and life line come and go together. The switch is kept in
 * `<world>/world.json`, so it outlasts a restart.
 */
export async function apply(ctx, config) {
    const dshHome = resolveDshHome();
    const picked = pickWorldDir(dshHome, config);
    const worldDir = picked.dir;
    if (picked.note)
        ctx.logger.warn(`dsh-world-home: ${picked.note}`);
    writeHomeRecord(worldDir);
    const store = createArchiveStore({ ...config, root: dshHome });
    const power = createWorldSwitch(worldDir, config.archiveScope ?? 'workspace');
    const memoryConfig = { ...config, archiveScope: power.archiveScope() };
    const faults = new Faults();
    if (picked.note)
        faults.set('home', picked.note);
    // Her self-description lives in her room whether or not the life line runs; she writes it with her file tools.
    const selfFile = config.selfFile || join(worldDir, 'room', '我是谁.md');
    const personaFile = config.personaFile || join(worldDir, 'persona.md');
    const worldPromptFile = config.worldPromptFile || join(worldDir, 'world-prompt.md');
    const schedule = createSchedule({ roomDir: join(worldDir, 'room'), defaults: { wake: config.fallbackWakeTime } });
    const options = { worldDir, roomDir: join(worldDir, 'room'), diaryDir: config.diaryDir || join(worldDir, 'diary'), selfFile, fallbackWakeTime: config.fallbackWakeTime, timeZone: config.timeZone, alarmFile: config.alarmTemplateFile || join(worldDir, 'alarm.md'), schedule: () => schedule.read() };
    /** The name in her persona comes first, then the configured one. */
    const names = () => worldNames({ ...config, companionName: readPersona(personaFile).名字 || config.companionName });
    const lifeStore = (() => {
        if (!config.life)
            return undefined;
        try {
            const current = createLifeStore(worldDir, config.timeZone);
            current.read();
            return current;
        }
        catch (error) {
            faults.set('life', `生活线没能启动：${errorText(error)}`);
            ctx.logger.error(error);
            return undefined;
        }
    })();
    /** 旧家的会话 id 记在这儿：搬走以后它们的闹钟都得清掉，不然两边会同时醒来干活。 */
    const formerHomesFile = join(worldDir, 'former-homes.json');
    function readFormerHomes() {
        try {
            const list = JSON.parse(readFileSync(formerHomesFile, 'utf8'));
            return Array.isArray(list) ? list.filter(id => typeof id === 'string') : [];
        }
        catch { return []; }
    }
    function rememberFormerHome(sessionId) {
        if (typeof sessionId !== 'string' || !sessionId)
            return;
        const list = readFormerHomes().filter(id => id !== sessionId);
        list.push(sessionId);
        try {
            writeFileSync(formerHomesFile, JSON.stringify(list.slice(-20), null, 1), 'utf8');
        }
        catch { /* 记不住也不能拦着搬家 */ }
    }
    /** 闹钟表在 DSH 的 storages 里；动它之前先留底，清错了还能从 schedule.bak 捡回来。 */
    const scheduleFile = () => join(resolveDshHome(), 'storages', 'schedule.json');
    function backupSchedules(why) {
        try {
            const file = scheduleFile();
            if (!existsSync(file))
                return;
            const dir = join(resolveDshHome(), 'storages', 'schedule.bak');
            mkdirSync(dir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            cpSync(file, join(dir, `${stamp}-${why}.json`));
            const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
            for (const name of files.slice(0, Math.max(0, files.length - 20)))
                rmSync(join(dir, name), { force: true });
        }
        catch (error) {
            ctx.logger.warn(`dsh-world-home: 备份闹钟表失败 ${errorText(error)}`);
        }
    }
    function readScheduleStore() {
        const file = scheduleFile();
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    }
    /** 先写临时文件再换名：写到一半崩了也不会把整张闹钟表弄坏。 */
    function writeScheduleStore(store) {
        const file = scheduleFile();
        const temp = `${file}.tmp`;
        writeFileSync(temp, JSON.stringify(store, null, 1), 'utf8');
        renameSync(temp, file);
    }
    function schedulesOn(store, sessionId) {
        const tasks = store?.tables?.tasks ?? {};
        return Object.values(tasks).filter(task => task?.sessionId === sessionId);
    }
    /** 启动后对齐一次：旧家的提醒先搬到当前家（新家没有同名任务才搬），剩下的再清掉。 */
    function alignFormerHomeSchedules() {
        try {
            const home = storedHome();
            if (!home)
                return;
            const stale = readFormerHomes().filter(id => id && id !== home);
            if (stale.length === 0)
                return;
            // 换家那一刻 DSH 可能延迟写回旧闹钟表，把迁移冲掉；启动时补一次迁移。
            try {
                const store = readScheduleStore();
                const tasks = store?.tables?.tasks ?? {};
                const mine = new Set(Object.values(tasks).filter(task => task?.sessionId === home).map(task => task?.record?.title));
                let moved = 0;
                for (const key of Object.keys(tasks)) {
                    const task = tasks[key];
                    if (!task || !stale.includes(task.sessionId))
                        continue;
                    const title = task?.record?.title;
                    if (title && mine.has(title))
                        continue;
                    task.sessionId = home;
                    if (title)
                        mine.add(title);
                    moved += 1;
                }
                if (moved > 0) {
                    backupSchedules('启动迁移');
                    writeScheduleStore(store);
                    ctx.logger.info(`dsh-world-home: 启动迁移，把旧家 ${moved} 条提醒挪回当前家`);
                }
            }
            catch (error) {
                ctx.logger.warn(`dsh-world-home: 启动迁移提醒失败 ${errorText(error)}`);
            }
            purgeSchedules(stale, '启动对齐');
        }
        catch (error) {
            ctx.logger.warn(`dsh-world-home: 启动对齐失败 ${error}`);
        }
    }
    /** 归档只是把会话收起来，挂在上面的闹钟不会自己跟着走：归档过的旧会话，闹钟一起清。 */
    function purgeArchivedSchedules() {
        try {
            const home = storedHome();
            const file = join(resolveDshHome(), 'storages', 'workspace.json');
            if (!existsSync(file))
                return 0;
            const store = JSON.parse(readFileSync(file, 'utf8'));
            const archived = new Set(store?.global?.archivedSessionIds ?? []);
            const stale = [...archived].filter(id => typeof id === 'string' && id && id !== home);
            return stale.length > 0 ? purgeSchedules(stale, '归档清理') : 0;
        }
        catch (error) {
            ctx.logger.warn(`dsh-world-home: 清归档会话的闹钟失败 ${errorText(error)}`);
            return 0;
        }
    }
    /** 把属于这些会话的提醒从 DSH 的闹钟表里删掉（只删我们记过的旧家）。 */
    function purgeSchedules(sessionIds, why) {
        const targets = new Set(Array.isArray(sessionIds) ? sessionIds : [sessionIds]);
        if (targets.size === 0)
            return 0;
        let removed = 0;
        try {
            const store = readScheduleStore();
            if (!store)
                return 0;
            const tasks = store?.tables?.tasks ?? {};
            for (const key of Object.keys(tasks)) {
                if (targets.has(tasks[key]?.sessionId)) {
                    delete tasks[key];
                    removed += 1;
                }
            }
            if (removed > 0) {
                backupSchedules(why);
                writeScheduleStore(store);
                ctx.logger.info(`dsh-world-home: ${why}，清掉旧家闹钟 ${removed} 个`);
            }
        }
        catch (error) {
            ctx.logger.warn(`dsh-world-home: 清旧家闹钟失败 ${errorText(error)}`);
        }
        return removed;
    }
    const waitMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 用不了就不等 */ } };
    /** 换家：把旧会话上挂着的提醒改绑到新会话。日记、复盘这类跟着家走的日程不能丢，删了就等于把提醒一起丢了。
     *  写失败也留一口气：挪完校验一遍，旧家还剩就再试；返回还剩几条，让调用方决定怎么收尾。 */
    function migrateSchedules(from, to) {
        if (!from || !to || from === to)
            return { moved: 0, remaining: 0 };
        let moved = 0;
        let remaining = 0;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                const store = readScheduleStore();
                if (!store)
                    return { moved, remaining: 0 };
                if (schedulesOn(store, from).length === 0)
                    return { moved, remaining: 0 };
                const tasks = store?.tables?.tasks ?? {};
                let touched = 0;
                for (const key of Object.keys(tasks)) {
                    if (tasks[key]?.sessionId === from) {
                        tasks[key].sessionId = to;
                        touched += 1;
                    }
                }
                if (touched > 0) {
                    backupSchedules('换家');
                    writeScheduleStore(store);
                }
                const check = readScheduleStore();
                remaining = schedulesOn(check, from).length;
                moved = touched;
                if (remaining === 0 && schedulesOn(check, to).length >= touched) {
                    if (moved > 0)
                        ctx.logger.info(`dsh-world-home: 换家用，把 ${moved} 条提醒挪到新家`);
                    return { moved, remaining: 0 };
                }
            }
            catch (error) {
                ctx.logger.warn(`dsh-world-home: 挪提醒失败（第 ${attempt + 1} 次）${errorText(error)}`);
            }
            waitMs(60);
        }
        ctx.logger.warn(`dsh-world-home: 换家没挪干净，旧家还挂着 ${remaining} 条提醒`);
        return { moved, remaining };
    }
    const storedHome = () => lifeStore?.read().homeSessionId;
    let isHome = id => id === storedHome();
    /**
     * 这条会话是不是渠道的群聊会话（QQ 群 / 微信群）。群会话每天会换，记录在房间的
     * `channel-rotate.json` 里；系统提示按它决定要不要加「这是群聊，不是工作台」那一块。
     */
    const isGroupSession = (id) => {
        try {
            const state = JSON.parse(readFileSync(join(options.roomDir, 'channel-rotate.json'), 'utf8'));
            return Object.values(state?.sessions ?? {}).some((one) => one?.sessionId === id);
        }
        catch {
            return false;
        }
    };
    const includesSession = createArchiveSelection(ctx, power.archiveScope(), id => isHome(id), options.roomDir);
    /** 长期记忆服务：聊天原文 + 日记，给 memory_find / memory_read 用（不依赖生活线）。 */
    const memoryService = createMemory({ store: createMemoryStore(store.db, { timeZone: config.timeZone }), sources: { diaryDir: options.diaryDir }, visible: id => includesSession(id), timeZone: config.timeZone });
    let memory;
    let stopLifeLine;
    async function startMemory(fresh) {
        if (memory)
            return;
        const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), names: names(), ...(config.life ? { life: options } : {}) };
        memory = createWorldRuntime(ctx, { ...memoryConfig, selfFile }, store, { prompt, isHome: id => isHome(id), isGroup: isGroupSession, archiveSession: includesSession, memory: memoryService }, power.memoryTurns);
        await memory.start({ fresh });
    }
    async function stopMemory() {
        const running = memory;
        memory = undefined;
        await running?.stop();
    }
    ctx.effect(() => async () => {
        try {
            await stopLifeLine?.();
        }
        finally {
            await stopMemory().finally(() => store.close());
        }
    }, 'dsh-world memory line');
    if (power.running())
        await startMemory(false);
    // The host's workspace service may come up after this plugin; what the first catch-up could not place is read then.
    ctx.inject(['workspaceRegistry'], injected => { void memory?.retryCatchUp().catch(error => injected.logger.error(error)); });
    // The console and the life line need the desktop host.
    ctx.inject(['sessionController', 'permissionPresets', 'webServer'], async (lifeCtx) => {
        const webServer = lifeCtx.webServer;
        const host = hostLife(lifeCtx);
        // QQ 的两扇门：她自己那条 OneBot 通道的状态与开关，以及 SnowLuma 的控制台。**无条件注册** —— 通道
        // 关着的时候 /native 回 null，而 SnowLuma 那扇门跟通道没关系。（这里原来还有一半是给外面那个
        // qq-bridge 进程用的，连 qqBridgeDir 一起在 2026-10-27 拆掉了。当时的教训：那条路由是注册在「有桥
        // 目录」这个分支里的，配置一摘，整片 /dsh-world/qq/* 就全 404，界面也一起没了。所以现在它不再挂在
        // 任何配置上 —— 端点先存在，功能再按需开关。）
        const doors = createConsoleDoors({ worldDir, snowlumaHome: config.qqNative?.snowlumaHome ?? '' });
        const unregisterQq = webServer.register(qqRoute(config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => {
            if (!qqNative)
                return null;
            if (patch.bridge)
                return qqNative.setBridge(patch.bridge);
            return qqNative.setAutoReply(patch.autoReply === true);
        }));
        lifeCtx.effect(() => () => unregisterQq(), 'dsh-world qq route');
        let life;
        let bridge;
        let wechat;
        let qqNative;
        let qqChannels;
        let adapter;
        let channels;
        let unregisterWechat;
        let lifeStop;
        let wechatClosing = Promise.resolve();
        /**
         * 刷B站那间屋子：路由和面板不依赖生活线（世界停着也能点「现在跑一轮」），但定时器和私信轮询
         * 跟着生活线起停 —— 世界停了就不该继续刷、继续轮询花白饭。
         */



    /** 每天换一次家会话：旧会话归档留档，新会话只带日记/记忆/规矩，不为前文付费。 */
    const dailyFile = join(options.roomDir, '每日会话.json');
    const readDaily = () => { try { return JSON.parse(readFileSync(dailyFile, 'utf8')) || {} } catch { return {} } };
    const writeDaily = (next) => { try { writeFileSync(dailyFile, JSON.stringify(next, null, 2), 'utf8') } catch { /* 记不住就明天再来 */ } };
    async function rotateDailyIfNeeded(force = false, silent = false) {
        try {
            if (config.rotateDaily === false)
                return false;
            const day = new Date().toLocaleDateString('sv-SE', { timeZone: config.timeZone || 'Asia/Shanghai' });
            const state = readDaily();
            if (!force && state.day === day && state.sessionId)
                return false;
            // 第一次启用（还没有每日家记录）：原 world 插件本来就会开一个家会话，今天就住那儿，别再另开一间。
            // 以前这里直接 createSession，和 start() 里的 home.open() 并发，第一次启动会同时出现
            // 「新家」和「每日房间」两个会话（2026-11-17 用户的反馈）。
            if (!state.sessionId) {
                let homeId = storedHome();
                if (!homeId || host.isArchived(homeId)) {
                    try {
                        homeId = (await life?.home?.())?.id;
                    }
                    catch { /* 家打不开就走下面的新建 */ }
                }
                if (homeId) {
                    writeDaily({ day, sessionId: homeId, at: new Date().toISOString(), named: false });
                    return true;
                }
            }
            const workspace = await host.workspace(options.roomDir, roomTitle(names()));
            const sessionId = await host.createSession(options.roomDir, config.agentPreset, workspace?.id);
            if (!sessionId)
                return false;
            try { await workspace?.attachSession(sessionId) } catch { /* 挂不上也不影响说话 */ }
            // 旧家的提醒跟着家走：日记、复盘这些日程挂在会话上，不挪过去 22:35 的提醒还会发给旧会话
            const previous = storedHome();
            if (previous && previous !== sessionId) {
                const { remaining } = migrateSchedules(previous, sessionId);
                // 旧家不能留死闹钟：挪干净就一条不剩；万一没挪干净，先留底再清，不让提醒挂在旧会话上
                if (remaining > 0) {
                    backupSchedules('换家残留');
                    purgeSchedules(previous, '换家残留');
                    ctx.logger.warn(`dsh-world-home: 换家后旧家还剩 ${remaining} 条提醒，已清掉（备份在 storages/schedule.bak）`);
                }
                // DSH 投递提醒后可能延迟写回旧表，把刚挪好的又冲回旧家：10 秒后核对一次，还有就再挪。
                setTimeout(() => {
                    try {
                        const { moved: again, remaining: left } = migrateSchedules(previous, sessionId);
                        if (again > 0)
                            ctx.logger.info(`dsh-world-home: 换家复核，又把 ${again} 条提醒挪到新家`);
                        if (left > 0) {
                            backupSchedules('换家复核残留');
                            purgeSchedules(previous, '换家复核残留');
                            ctx.logger.warn(`dsh-world-home: 换家复核后旧家还剩 ${left} 条提醒，已清掉`);
                        }
                    }
                    catch (error) {
                        ctx.logger.warn(`dsh-world-home: 换家复核失败 ${errorText(error)}`);
                    }
                }, 10000);
                rememberFormerHome(previous);
            }
            life?.adopt?.(sessionId);
            writeDaily({ day, sessionId, at: new Date().toISOString(), named: false });
            // 换家那一刻的提示可能落空（新会话 agent 还没接上），DSH 又会先给新会话自动起个任务名。
            // 所以只要今天还没取名，30 秒后再补一句，保证“先给今天取个名字”真的到眼前。
            setTimeout(() => {
                try {
                    const state = readDaily();
                    if (state.day === day && state.named === false && !state.nameAsked) {
                        writeDaily({ ...state, nameAsked: true });
                        void wakeHome(`【来自插件通知·取名字】今天（${day}）还没取名。用 name_today 给自己取一个：此刻的心情和这一天的期许，一两个词，不写成工作汇报。`, 'dsh-world-newname');
                    }
                }
                catch (error) {
                    lifeCtx.logger.warn('[daily] 取名提醒没送出去：' + errorText(error));
                }
            }, 30000);
            purgeArchivedSchedules();
            if (!silent)
                await wakeHome(`【来自插件通知·新的一天】今天是 ${day}。这是新会话——旧会话已经留在归档里，你的日记、记忆、规矩都在房间里，随时能翻。\n先给今天取个名字（用 name_today）：写你此刻的心情和这一天的期许，不是工作报告，一两个词就够。然后该怎么过就怎么过。`, 'dsh-world-newday');
            return true;
        }
        catch (error) {
            lifeCtx.logger.warn('[daily] 换会话失败：' + errorText(error));
            return false;
        }
    }
    async function renameToday(title) {
        try {
            const home = storedHome();
            const clean = String(title || '').trim().slice(0, 28);
            if (!home || !clean)
                return '没改成——没有当前会话，或者名字是空的。';
            // 房间名后面接当天日期，比如「收一收 11-08」；跨天了也分得清哪天。
            const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
            const named = stamp ? `${clean} ${stamp}` : clean;
            await host.rename(home, named);
            writeDaily({ ...readDaily(), named: true });
            return `今天的名字改好了：${named}`;
        }
        catch (error) {
            return '改名失败：' + errorText(error);
        }
    }

    /** 作息窗口：在时间段里随机挑时候叫醒她，主动找主人说话。 */
    const wakeLogFile = join(options.roomDir, 'QQ', 'wake-log.json');
    const readWakeLog = () => { try { return JSON.parse(readFileSync(wakeLogFile, 'utf8')) || {} } catch { return {} } };
    const writeWakeLog = (next) => { try { mkdirSync(join(options.roomDir, 'QQ'), { recursive: true }); writeFileSync(wakeLogFile, JSON.stringify(next, null, 2), 'utf8') } catch { /* 记不住就算了 */ } };
    const minutesOf = (text) => { const [h, m] = String(text || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) };
    async function wakeHome(text, kind = 'dsh-world-wake') {
        try {
            const home = storedHome();
            if (!home)
                return false;
            const agent = await host.resolveAgent(home);
            if (!agent)
                return false;
            agent.steer(createUserMessage({ source: { kind }, content: [{ type: 'text', text }] }));
            await ctx.sessions.flush(agent.session);
            return true;
        }
        catch (error) {
            lifeCtx.logger.warn('[wake] 叫不醒：' + errorText(error));
            return false;
        }
    }
    /** 日记提醒：不挂 DSH 的闹钟表（换家会被写回冲掉、还会漏到旧家），走插件自己的定时器，到点直接叫当前家。 */
    const diaryReminderFile = join(options.roomDir, '日记提醒.json');
    const readDiaryReminder = () => { try { return JSON.parse(readFileSync(diaryReminderFile, 'utf8')) || {} } catch { return {} } };
    let diaryReminding = false;
    async function diaryTick() {
        try {
            if (diaryReminding)
                return;
            const now = new Date();
            const tz = config.timeZone || 'Asia/Shanghai';
            const day = now.toLocaleDateString('sv-SE', { timeZone: tz });
            const hhmm = now.toLocaleTimeString('sv-SE', { timeZone: tz }).slice(0, 5);
            const diary = schedule.read().diary;
            const end = addClockMinutes(diary, 65);
            const inside = diary <= end ? (hhmm >= diary && hhmm <= end) : (hhmm >= diary || hhmm <= end);
            if (!inside)
                return;
            if (readDiaryReminder().day === day)
                return;
            diaryReminding = true;
            try {
                const text = `【来自插件通知·日记时间】${day} ${diary} 了，该写今天的日记了。先看一眼你记的规矩，再按平时的步骤写（没记规矩就按你习惯来）；写完把收尾的事做一遍。`;
                const ok = await wakeHome(text, 'dsh-world-diary');
                if (ok)
                    writeFileSync(diaryReminderFile, JSON.stringify({ day, at: now.toISOString() }, null, 2), 'utf8');
            }
            finally { diaryReminding = false; }
        }
        catch (error) {
            diaryReminding = false;
            lifeCtx.logger.warn('[diary] 日记提醒没送出去：' + errorText(error));
        }
    }
    async function wakeTick() {
        try {
            if (!power.running())
                return;
            const cfg = readQqOverride();
            const windows = Array.isArray(cfg.windows) && cfg.windows.length ? cfg.windows : DEFAULT_WINDOWS;
            const minGap = Number(cfg.minGapMinutes ?? 10) * 60000;
            const now = new Date();
            const day = now.toLocaleDateString('sv-SE', { timeZone: config.timeZone || 'Asia/Shanghai' });
            const minute = now.toLocaleTimeString('sv-SE', { timeZone: config.timeZone || 'Asia/Shanghai' }).slice(0, 5);
            const log = readWakeLog();
            const state = log.day === day ? log : { day, counts: {}, lastAt: 0 };
            for (let index = 0; index < windows.length; index += 1) {
                const one = windows[index];
                const start = minutesOf(one.start), end = minutesOf(one.end), at = minutesOf(minute);
                const inside = end >= start ? (at >= start && at < end) : (at >= start || at < end);
                if (!inside)
                    continue;
                const used = state.counts[index] || 0;
                const left = Math.max(0, (Number(one.times) || 1) - used);
                if (!left)
                    continue;
                if (Date.now() - (state.lastAt || 0) < minGap)
                    continue;
                const remaining = (end >= start ? end - at : (24 * 60 - at + end)) || 1;
                if (Math.random() > left / remaining * 3)
                    continue;
                const ok = await wakeHome(`【来自插件通知·作息】现在是你自己的时间窗口（${one.start}–${one.end}）。想找${names().partner}说话的话，用 QQ 私聊找他——想分享什么、想问什么、或者只是冒个头都行；不想说就继续忙自己的，这条不用回。`);
                if (ok) {
                    state.counts[index] = used + 1;
                    state.lastAt = Date.now();
                    writeWakeLog(state);
                }
                return;
            }
        }
        catch (error) { lifeCtx.logger.warn('[wake] 定时器出错：' + errorText(error)); }
    }

        const bili = createBili({
            roomDir: options.roomDir,
            // 走“闹钟”那条路：消息来源是插件自己（dsh-world-bili），不是主人说的话
            notify: async (text) => {
                try {
                    const home = storedHome();
                    if (!home)
                        return false;
                    const agent = await host.resolveAgent(home);
                    if (!agent)
                        return false;
                    agent.steer(createUserMessage({
                        source: { kind: 'dsh-world-bili' },
                        content: [{ type: 'text', text: String(text || '') }],
                    }));
                    await ctx.sessions.flush(agent.session);
                    return true;
                }
                catch (error) {
                    lifeCtx.logger.warn('[bili] 闹钟通知没送出去：' + errorText(error));
                    return false;
                }
            },
            stateDir: config.bili?.stateDir || join(options.roomDir, 'B站'),
            bridge: () => bridge,
            config: config.bili ?? {},
            running: () => power.running(),
            enabled: () => power.biliEnabled(),
            setEnabled: (value) => { power.setModules({ bili: value }); sources?.invalidate?.(); },
            log: message => lifeCtx.logger.info('[bili] ' + message),
            warn: message => lifeCtx.logger.warn('[bili] ' + message),
        });
        lifeCtx.effect(() => webServer.register(biliRoute(bili, config.allowedHosts)), 'dsh-world bili route')
        lifeCtx.effect(() => {
            const timer = setInterval(() => { void wakeTick() }, 60 * 1000);
            const diaryTimer = setInterval(() => { void diaryTick() }, 60 * 1000);
            void diaryTick();
            return () => { clearInterval(timer); clearInterval(diaryTimer) };
        }, 'dsh-world 作息窗口');
        /** Starts the WeChat module (its tools, route and, when configured, the adapter) against the running life line. */
        async function startWechat(current) {
            if (wechat || !config.wechat)
                return;
            await wechatClosing;
            const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
            channels = groupSessions;
            wechat = createWechatModule({ ctx: lifeCtx, worldId: config.worldId, acceptAgent: agent => belongsToWorld(agent.session, config), home: identity => identity.conversationType === 'group' ? groupSessions.open(identity) : current.home(), origin: () => host.origin(), file: join(worldDir, 'wechat.json'), incomingDir: join(worldDir, 'wechat-incoming'), allowedHosts: config.allowedHosts, settings: () => ({ contextMessages: power.wechatContext(), bufferSeconds: power.wechatBufferSeconds() }),
                ...createWechatRecorder(store, config.worldId, includesSession) });
            wechat.start();
            unregisterWechat = webServer.register(wechat.route);
            if (config.wechatAdapter?.python && config.wechatAdapter.config) {
                adapter = createAdapterSupervisor({ python: config.wechatAdapter.python, config: config.wechatAdapter.config, logFile: join(worldDir, 'wechat-adapter.log'), log: message => lifeCtx.logger.warn(message) });
                adapter.start();
            }
        }
        /** Takes the WeChat tools, route and adapter down; the adapter goes first because it exits when the module's connection file disappears. */
        function stopWechat() {
            unregisterWechat?.();
            unregisterWechat = undefined;
            const closingAdapter = adapter?.stop();
            adapter = undefined;
            const closing = Promise.all([closingAdapter, wechat?.stop()]).then(() => { });
            wechat = undefined;
            channels?.stop();
            channels = undefined;
            return wechatClosing = closing;
        }
    



    /** 看一眼某个备份目录里有什么（只读）。 */
    const backupInspect = (dir) => {
        const root = String(dir || '').trim();
        if (!root)
            return { ok: false, error: '先填备份目录' };
        if (!existsSync(root))
            return { ok: false, error: '这个目录不存在：' + root };
        const found = [];
        for (const item of backupTargets()) {
            const from = join(root, item.to);
            if (existsSync(from)) found.push(item.to);
        }
        let bytes = 0;
        try {
            const walk = (one) => {
                const info = statSync(one);
                if (info.isDirectory()) for (const child of readdirSync(one)) walk(join(one, child));
                else bytes += info.size;
            };
            walk(root);
        }
        catch { /* 大小算不出来不影响 */ }
        return { ok: true, dir: root, items: found, mb: Math.round(bytes / 1048576 * 10) / 10 };
    };
    /** 把备份拷回去：只覆盖、不删除；dry 时只报会写哪些。可以指定恢复到哪块盘（换电脑 / 第一次用插件时用）。 */
    const backupRestore = (options = {}) => {
        const root = String(options.dir || '').trim();
        const dry = options.dry !== false;
        if (!root)
            return { ok: false, error: '先填备份目录' };
        if (!existsSync(root))
            return { ok: false, error: '这个目录不存在：' + root };
        const drive = String(options.drive || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
        if (drive && drive.length !== 1)
            return { ok: false, error: '恢复目标盘要一个盘符，比如 E' };
        if (drive && !existsSync(`${drive}:\\`))
            return { ok: false, error: '这块盘现在不在了：' + drive };
        const restoreRoot = drive ? `${drive}:\\dsh-world\\worlds` : dirname(worldDir);
        const target = join(restoreRoot, config.worldId);
        const plan = targetsFor(target).filter((item) => existsSync(join(root, item.to)));
        if (!plan.length)
            return { ok: false, error: '这个目录里没有能恢复的东西' };
        const written = [];
        if (!dry) {
            for (const item of plan) {
                try {
                    mkdirSync(join(item.from, '..'), { recursive: true });
                    cpSync(join(root, item.to), item.from, { recursive: true, force: true });
                    written.push(item.to);
                }
                catch (error) { lifeCtx.logger.warn('[backup] 恢复 ' + item.to + ' 失败：' + errorText(error)); }
            }
            // 恢复到别的盘：把家记在新地方，下次启动就在那儿醒来
            if (drive && written.length) {
                try { mkdirSync(restoreRoot, { recursive: true }); writeHomeOverride(dshHome, restoreRoot); }
                catch (error) { lifeCtx.logger.warn('[backup] 记下新家位置失败：' + errorText(error)); }
            }
        }
        return { ok: true, dir: root, dry, drive: drive || null, restoreTo: target, plan: plan.map((one) => one.to), written, restartRequired: !dry && Boolean(drive) && written.length > 0 };
    };

    const DEFAULT_WINDOWS = [
        { start: '12:00', end: '14:00', times: 1 },
        { start: '18:00', end: '23:00', times: 1 },
    ];
    /** 默认用她自己的名字当关键词；设置页里改的会覆盖它。 */
    const defaultGroupKeywords = () => [names().companion].filter(Boolean);
    /** 把 9:5 / 9：05 这类写法补成 09:05；不合法返回 ''。 */
    const normalizeTimeText = (value) => {
        const text = String(value || '').trim().replace('：', ':');
        const m = /^(\d{1,2}):(\d{1,2})$/.exec(text);
        if (!m)
            return '';
        const h = Number(m[1]), min = Number(m[2]);
        if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59))
            return '';
        return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
    };

    /** 备份：只拷白名单（房间、人格、说明书、生活线、profile 配置），结构照原样，恢复不删东西。 */
    const backupRoot = () => join(resolveDshHome(), 'backups');
    const backupCfgFile = join(options.roomDir, '备份', 'config.json');
    const readBackupCfg = () => {
        try { return JSON.parse(readFileSync(backupCfgFile, 'utf8')) || {} }
        catch { return {} }
    };
    const writeBackupCfg = (patch) => {
        const next = { ...readBackupCfg(), ...patch };
        try {
            mkdirSync(join(options.roomDir, '备份'), { recursive: true });
            writeFileSync(backupCfgFile, JSON.stringify(next, null, 2), 'utf8');
        }
        catch { /* 记不住就每次手填 */ }
        return next;
    };
    /** 备份/恢复共用的清单：家里的东西收进 world/，profile 里的按原相对路径收。家在哪就收哪，不再写死 C 盘。 */
    const targetsFor = (homeDir) => [
        { from: homeDir, to: 'world/room' },
        { from: join(homeDir, 'conversations'), to: 'world/conversations' },
        { from: join(homeDir, 'diary'), to: 'world/diary' },
        { from: join(homeDir, 'persona.md'), to: 'world/persona.md' },
        { from: join(homeDir, 'world-prompt.md'), to: 'world/world-prompt.md' },
        { from: join(homeDir, 'world.json'), to: 'world/world.json' },
        { from: join(homeDir, 'life.json'), to: 'world/life.json' },
        { from: join(homeDir, 'former-homes.json'), to: 'world/former-homes.json' },
        { from: join(homeDir, 'qq-native.json'), to: 'world/qq-native.json' },
        { from: join(homeDir, 'bridge.json'), to: 'world/bridge.json' },
        { from: join(homeDir, 'archive.sqlite'), to: 'world/archive.sqlite' },
        { from: join(dshHome, 'profiles/desktop/cordis.patch.yml'), to: 'profiles/desktop/cordis.patch.yml' },
        { from: join(dshHome, 'profiles/desktop/package.json'), to: 'profiles/desktop/package.json' },
        { from: join(dshHome, 'profiles/desktop/pnpm-workspace.yaml'), to: 'profiles/desktop/pnpm-workspace.yaml' },
    ].concat((() => {
        // 《家的说明书》可能被改到别处（那也是世界提示词），一起带上；在家里的就收进 world/
        const file = config.worldPromptFile;
        if (!file)
            return [];
        try {
            const inside = relative(homeDir, file);
            return [{ from: file, to: inside.startsWith('..') ? join('说明', 'world-prompt.md') : join('world', inside) }];
        }
        catch {
            return [];
        }
    })());
    const backupTargets = () => targetsFor(worldDir);

    const backupStamp = () => new Date().toLocaleString('sv-SE', { timeZone: config.timeZone || 'Asia/Shanghai' }).replace(' ', '-').replace(/:/g, '').slice(0, 15);
    const backupInfo = () => {
        const root = backupRoot();
        let last = null;
        try {
            const dirs = readdirSync(root, { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => one.name).sort();
            last = dirs.at(-1) || null;
        }
        catch { /* 还没有过备份 */ }
        const rooms = options.roomDir;
        let roomBytes = 0;
        try {
            const walk = (dir) => {
                for (const one of readdirSync(dir, { withFileTypes: true })) {
                    const full = join(dir, one.name);
                    if (one.isDirectory()) walk(full);
                    else roomBytes += statSync(full).size;
                }
            };
            walk(rooms);
        }
        catch { /* 房间还没建 */ }
        return { ok: true, root, defaultRoot: root, savedDir: String(readBackupCfg().dir || ''), last, roomMB: Math.round(roomBytes / 1048576 * 10) / 10, worldDir, homeRoot: dirname(worldDir), worldId: config.worldId };
    };
    const backupRun = (options = {}) => {
        const stamp = backupStamp();
        const remembered = String(readBackupCfg().dir || '').trim();
        const parent = options.dir && String(options.dir).trim() ? String(options.dir).trim() : (remembered || backupRoot());
        const root = join(parent, `${names().companion}-${stamp}`);
        const dry = options.dry === true;
        const plan = backupTargets().filter((item) => existsSync(item.from));
        if (dry)
            return { ok: true, dir: root, dry, copied: plan.map((one) => one.to), items: plan.length };
        const copied = [];
        for (const item of plan) {
            try {
                const dest = join(root, item.to);
                mkdirSync(join(dest, '..'), { recursive: true });
                cpSync(item.from, dest, { recursive: true, force: true });
                copied.push(item.to);
            }
            catch (error) { lifeCtx.logger.warn('[backup] ' + item.to + ' 没拷成：' + errorText(error)); }
        }
        try {
            writeFileSync(join(root, '备份说明.json'), JSON.stringify({
                kind: 'dsh-world-home-backup',
                version: 2,
                createdAt: new Date().toISOString(),
                homeRoot: dirname(worldDir),
                worldDir,
                worldId: config.worldId,
                items: copied,
            }, null, 2), 'utf8');
            writeFileSync(join(root, '怎么救活我.md'), [
                '# 怎么救活她',
                '',
                '这个文件夹就是她的全部：日记、记忆、规矩、聊天记录、B站登录、人格、说明书。',
                '',
                '## 换电脑时',
                '1. 新电脑装好 DSH，并打开一次桌面端（生成 `~/.dsh/profiles/desktop`）',
                '2. 把家插件装回来',
                '3. 设置 → 记录与备份 → 填这个文件夹的路径 → 看看有什么 → 预演恢复 → 真的恢复',
                '   （想放到别的盘：先点那块盘，再恢复；插件会在那块盘上建 dsh-world\\\\worlds）',
                '4. 重启 DSH',
                '',
                '恢复只覆盖、不删除。',
                '',
                `备份时间：${new Date().toISOString()}`,
            ].join('\n'), 'utf8');
        }
        catch { /* 说明文件写不进去不影响数据 */ }
        try { writeBackupCfg({ dir: parent }); } catch { /* 不影响这次备份 */ }
        return { ok: true, dir: root, dry, copied, items: copied.length };
    };

    /** QQ 设置页存的覆盖项：主人 QQ、群白名单、静默阈值。存在房间里，跟着家一起备份。 */
    const qqOverrideFile = join(options.roomDir, 'QQ', 'config.json');
    const readQqOverride = () => {
        try { return JSON.parse(readFileSync(qqOverrideFile, 'utf8')) || {} }
        catch { return {} }
    };
    const writeQqOverride = (patch) => {
        const next = { ...readQqOverride(), ...patch };
        try {
            const dir = join(options.roomDir, 'QQ');
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(qqOverrideFile, JSON.stringify(next, null, 2), 'utf8');
        }
        catch (error) { lifeCtx.logger.warn('[qq] 设置没写下来：' + errorText(error)); }
        return next;
    };
    /** QQ talks to her through the same home the WeChat channel uses; only the transport differs. */
        async function startQqNative(current) {
            const q = config.qqNative;
            if (qqNative || !q?.enabled || !power.qqEnabled())
                return;
            try {
                const { createQqNativeModule } = await import("./ecosystem/qq-native/index.js");
                if (qqNative || life !== current || !power.running() || !power.qqEnabled())
                    return;
                const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
                qqChannels = groupSessions;
                qqNative = createQqNativeModule({
                    ctx: lifeCtx,
                    // `none` keeps private test traffic out of her real home, as groups are by default.
                    home: identity => {
                        const bind = q.bindHomeSession ?? 'owner';
                        if (identity.conversationType === 'group')
                            return bind === 'all' ? current.home() : groupSessions.open(identity);
                        return bind === 'none' ? groupSessions.open(identity) : current.home();
                    },
                    logger: lifeCtx.logger,
                    stateFile: join(options.roomDir, '..', 'qq-native.json'),
                    config: () => ({
                        enabled: q.enabled ?? false,
                        wsUrl: q.wsUrl ?? 'ws://127.0.0.1:3003',
                        accessToken: q.accessToken ?? '',
                        allowPrivate: (() => {
                            const override = readQqOverride();
                            const list = Array.isArray(override.allowPrivate) ? override.allowPrivate.map(String) : [];
                            const owner = override.ownerQQ ? [String(override.ownerQQ)] : [];
                            const base = Array.isArray(q.allowPrivate) ? q.allowPrivate.map(String) : [];
                            return [...new Set([...base, ...owner, ...list])];
                        })(),
                        allowGroups: (() => {
                            const override = readQqOverride();
                            return Array.isArray(override.allowGroups) ? override.allowGroups.map(String) : (q.allowGroups ?? []);
                        })(),
                        autoReply: q.autoReply ?? true,
                        contextMessages: q.contextMessages ?? 6,
                        groupTrigger: q.groupTrigger ?? 'mention',
                        groupKeywords: (() => {
                            const override = readQqOverride();
                            return Array.isArray(override.groupKeywords) ? override.groupKeywords.map(String) : (q.groupKeywords ?? defaultGroupKeywords());
                        })(),
                        // 陪伴窗口多长、两次叫醒隔多久、谁算主人，都从设置页来。
                        silenceMinutes: Number(readQqOverride().silenceMinutes ?? 5) || 5,
                        wakeGapSeconds: Number(readQqOverride().wakeGapSeconds ?? 20) || 20,
                        followupOnSpoke: readQqOverride().followupOnSpoke !== false,
                        ownerQQ: String(readQqOverride().ownerQQ ?? q.allowPrivate?.[0] ?? ''),
                        bridge: {
                            port: q.bridge?.port ?? 0,
                            token: q.bridge?.token ?? '',
                            title: q.bridge?.title ?? '阳台',
                            contextMessages: q.bridge?.contextMessages ?? 6,
                        },
                        bindHomeSession: q.bindHomeSession ?? 'owner',
                    }),
                });
                qqNative.start();
                faults.clear('qq');
            }
            catch (error) {
                stopQqNative();
                faults.set('qq', `QQ 模块没能启动：${errorText(error)}`);
                lifeCtx.logger.error(error);
            }
        }
        function stopQqNative() { qqNative?.stop(); qqNative = undefined; qqChannels?.stop(); qqChannels = undefined; faults.clear('qq'); }
        async function startLife(resumed) {
            if (!lifeStore || life)
                return;
            alignFormerHomeSchedules();
            purgeArchivedSchedules();
            try {
                await lifeStop;
                const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
                const notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast() } : {}), outlets };
                // 醒来时递一眼群里最近 30 条（纯文字，图只写 [图]）；room\QQ\config.json 里 groupDigestOnWake=false 就关掉。
                const wakeExtra = async () => {
                    try {
                        if (readQqOverride().groupDigestOnWake === false)
                            return '';
                        return await qqNative?.digest?.(30) || '';
                    }
                    catch {
                        return '';
                    }
                };
                // 醒来前先看日子：新的一天就换新家（不另发“新的一天”，让这次闹钟本身当那次叫醒）。
                // 新的一天就换新家；昨晚已经搬过、今天沿用那条，也算“今天是新的”——要取名。
                // 名字还没取（named 为假）就每次醒来提一句，取完为止。
                const beforeWake = async () => {
                    try {
                        const rotated = await rotateDailyIfNeeded(false, true);
                        return rotated || readDaily().named === false;
                    }
                    catch { return false; }
                };
                const current = createLifeRuntime({ ctx: lifeCtx, config: { ...config, companionName: names().companion }, options, store: lifeStore, host, notifier, dailyBudget: power.dailyBudget, renameToday, wakeExtra, beforeWake });
                life = current;
                isHome = current.isHome;
                if (config.bridge) {
                    bridge = createBridge({ ctx: lifeCtx, home: () => current.home(), outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names().companion });
                    bridge.start();
                }
                // 刷B站的定时器要桥已经在了才挂，不然第一次叫醒就落空
                if (power.biliEnabled())
                    bili.start();
                void rotateDailyIfNeeded();
                if (config.wechat && power.wechatEnabled())
                    await startWechat(current);
                if (config.qqNative?.enabled && power.qqEnabled())
                    await startQqNative(current);
                faults.clear('life');
                await current.start({ resumed });
            }
            catch (error) {
                // The console still opens and says why, instead of looking as if the life line were simply off.
                await stopLife();
                faults.set('life', `生活线没能启动：${errorText(error)}`);
                lifeCtx.logger.error(error);
            }
        }
        function stopLife() {
            isHome = id => id === storedHome();
            bili.stop();
            bridge?.stop();
            life?.stop();
            const closingWechat = stopWechat();
            stopQqNative();
            bridge = undefined;
            life = undefined;
            return lifeStop = Promise.all([lifeStop, closingWechat]).then(() => { });
        }
        stopLifeLine = stopLife;
        lifeCtx.effect(() => () => stopLife(), 'dsh-world life line');
        // The host matches exact routes before the longest prefix, so this path never reaches the console.
        if (config.bridge)
            lifeCtx.effect(() => webServer.register(bridgeRoute(() => bridge, config.allowedHosts)), 'dsh-world bridge route');
        // Her album lives in her room, so the console shows it whether or not the life line is running.
        const sources = consoleSources({ ctx: lifeCtx, config: memoryConfig, archive: store, names, ...(lifeStore ? { lifeStore } : {}), life: () => life, diaryDir: options.diaryDir, roomDir: options.roomDir, running: power.running, dailyBudget: power.dailyBudget, memoryTurns: power.memoryTurns, selectedArchiveScope: power.selectedArchiveScope, home: () => describeHome(dshHome, config, worldDir), schedule: () => schedule.read(), wechat: () => wechat ? { ...wechat.status(), adapter: adapter?.status() ?? null } : undefined, includesSession, native: () => qqNative?.status() ?? null,
            modules: () => ({ wechat: { available: config.wechat, enabled: power.wechatEnabled(), running: wechat !== undefined }, qq: { available: Boolean(config.qqNative?.enabled), enabled: power.qqEnabled(), running: qqNative !== undefined }, bili: { available: true, enabled: power.biliEnabled(), running: bili.snapshot().armed } }), faults: () => [...faults.list(), ...(memory?.faults() ?? []), ...(bridge?.faults() ?? [])] });
        const actions = {
            /**
             * 第一次用插件：挑一块盘放家。选了就在那块盘上建 `<盘>:\dsh-world\worlds`，
             * 下次启动插件照这儿生成房间。中途搬家不走这里（那条路是迁移脚本）。
             * 已经有家的时候只记下选择，启动时照旧用现在的家——绝不开一个空家。
             */
            setHomeLocation(drive) {
                const letter = typeof drive === 'string' ? drive.trim().toUpperCase().replace(/[^A-Z]/g, '') : '';
                if (letter.length !== 1)
                    return { error: '要选一块盘' };
                if (!existsSync(`${letter}:\\`))
                    return { error: '这块盘现在不在了' };
                const roots = `${letter}:\\dsh-world\\worlds`;
                const dir = join(roots, config.worldId);
                const there = hasHome(dir);
                try {
                    mkdirSync(roots, { recursive: true });
                }
                catch (error) {
                    return { error: `在那块盘上建目录失败了：${errorText(error)}` };
                }
                writeHomeOverride(dshHome, roots);
                return {
                    letter: letter, root: roots, dir, hasHome: there,
                    message: there
                        ? `已记下：家放在 ${roots}（那里已经有家）。`
                        : `已记下：家放在 ${roots}，下次启动插件时在那块盘上生成房间。`,
                };
            },
            /** 扫这台电脑上有哪些盘、各剩多少（第一次选家路径用）。 */
            listDrives() {
                const out = [];
                for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
                    const root = `${letter}:\\`;
                    if (!existsSync(root))
                        continue;
                    let freeGB = 0, totalGB = 0;
                    try {
                        const st = statfsSync(root);
                        freeGB = Math.round((Number(st.bavail) * Number(st.bsize)) / 1e9);
                        totalGB = Math.round((Number(st.blocks) * Number(st.bsize)) / 1e9);
                    }
                    catch { /* 光驱之类的读不到就算了 */ }
                    out.push({ letter, root, freeGB, totalGB });
                }
                return out;
            },
            /** 列出可以当家的会话（最近写过的在前，带标题）。 */
            listSessions() {
                const home = resolveDshHome();
                const root = join(home, 'sessions');
                const cache = join(home, 'storages', 'session_projcache', 'sessions');
                const titles = {};
                try {
                    for (const f of readdirSync(cache)) {
                        if (!f.endsWith('.json'))
                            continue;
                        try {
                            const j = JSON.parse(readFileSync(join(cache, f), 'utf8'));
                            titles[j?.record?.rows?.title?.val] = j?.record?.rows?.title?.val;
                            const id = f.replace(/\.json$/, '');
                            titles[id] = j?.record?.rows?.title?.val || '';
                        }
                        catch { /* 坏文件跳过 */ }
                    }
                }
                catch { /* 没有缓存目录 */ }
                const out = [];
                try {
                    for (const group of readdirSync(root)) {
                        let ids = [];
                        try {
                            ids = readdirSync(join(root, group));
                        }
                        catch {
                            continue;
                        }
                        for (const sid of ids) {
                            const file = join(root, group, sid, 'session.v4.jsonl.zstd');
                            if (!existsSync(file))
                                continue;
                            out.push({ id: sid, title: titles[sid] || '', cwd: group, at: statSync(file).mtimeMs });
                        }
                    }
                }
                catch { /* 没有 sessions 目录 */ }
                out.sort((a, b) => b.at - a.at);
                return out.slice(0, 40);
            },
            /** 把家移到某条已有会话：世界开着就直接换；停着就只写进 life.json，等下次开始用。 */
            async setHome(sessionId) {
                if (!/^session-[0-9a-f-]{36}$/i.test(String(sessionId || '')))
                    throw new Error('会话 id 不合法');
                if (!life) {
                    if (!lifeStore)
                        throw new Error('这条世界还没有生活线存储');
                    const agent = await host.resolveAgent(sessionId).catch(() => undefined);
                    if (!agent)
                        throw new Error('这条会话找不到了');
                    const state = lifeStore.read();
                    state.homeSessionId = sessionId;
                    lifeStore.write(state);
                    sources.invalidate?.();
                    return;
                }
                const agent = await host.resolveAgent(sessionId);
                if (!agent)
                    throw new Error('这条会话找不到了');
                // 搬家的规则：旧家的提醒跟着家走（日记、复盘不能丢），剩下的旧闹钟清掉，不然两边会同时醒来干活
                const previous = lifeStore ? lifeStore.read().homeSessionId : undefined;
                if (previous && previous !== sessionId) {
                    rememberFormerHome(previous);
                    migrateSchedules(previous, sessionId);
                    purgeSchedules(previous, '搬家');
                }
                life.adopt(sessionId);
                // 搬家之后：把“今天用哪个会话”也记成新的，免得下次启动又换一次
                try {
                    writeDaily({ day: new Date().toLocaleDateString('sv-SE', { timeZone: config.timeZone || 'Asia/Shanghai' }), sessionId, at: new Date().toISOString() });
                }
                catch { /* 不影响搬家 */ }
                sources.invalidate?.();
            },
            /** 备份页：看一眼现状 / 跑一次备份。 */
            backupInfo: () => backupInfo(),
            backupRun: (options) => backupRun(options || {}),
            backupInspect: (dir) => backupInspect(dir),
            backupRestore: (options) => backupRestore(options || {}),
            /** QQ 设置页：读/写覆盖项（主人 QQ、群白名单、静默阈值）。 */
            getQq() {
                const override = readQqOverride();
                const allowPrivate = (config.qqNative?.allowPrivate ?? []).map(String);
                const allowGroups = (config.qqNative?.allowGroups ?? []).map(String);
                return {
                    ok: true,
                    ownerQQ: override.ownerQQ ?? allowPrivate[0] ?? '',
                    silenceMinutes: Number(override.silenceMinutes ?? 5),
                    wakeGapSeconds: Number(override.wakeGapSeconds ?? 20),
                    splitDm: override.splitDm !== false,
                    windows: Array.isArray(override.windows) && override.windows.length ? override.windows : DEFAULT_WINDOWS,
                    minGapMinutes: Number(override.minGapMinutes ?? 10),
                    allowGroups: Array.isArray(override.allowGroups) ? override.allowGroups : allowGroups,
                    groupKeywords: Array.isArray(override.groupKeywords) ? override.groupKeywords : (config.qqNative?.groupKeywords ?? defaultGroupKeywords()),
                    enabled: config.qqNative?.enabled === true,
                    baseAllowPrivate: allowPrivate,
                };
            },
            saveQq(patch) {
                const next = {};
                if (typeof patch?.ownerQQ === 'string')
                    next.ownerQQ = patch.ownerQQ.replace(/\D/g, '').slice(0, 20);
                if (patch?.silenceMinutes !== undefined) {
                    const n = Number(patch.silenceMinutes);
                    if (Number.isFinite(n) && n >= 1 && n <= 120)
                        next.silenceMinutes = Math.round(n);
                }
                if (patch?.wakeGapSeconds !== undefined) {
                    const n = Number(patch.wakeGapSeconds);
                    if (Number.isFinite(n) && n >= 3 && n <= 300)
                        next.wakeGapSeconds = Math.round(n);
                }
                if (Array.isArray(patch?.allowGroups))
                    next.allowGroups = patch.allowGroups.map((one) => String(one).replace(/\D/g, '')).filter(Boolean).slice(0, 20);
                if (Array.isArray(patch?.groupKeywords))
                    next.groupKeywords = patch.groupKeywords.map((one) => String(one).trim()).filter(Boolean).slice(0, 10);
                if (Array.isArray(patch?.windows)) {
                    const clean = patch.windows.map((one) => ({
                        start: normalizeTimeText(one?.start),
                        end: normalizeTimeText(one?.end),
                        times: Math.min(20, Math.max(1, Math.round(Number(one?.times) || 1))),
                    })).filter((one) => one.start && one.end).slice(0, 8);
                    if (clean.length)
                        next.windows = clean;
                }
                if (patch?.minGapMinutes !== undefined) {
                    const n = Number(patch.minGapMinutes);
                    if (Number.isFinite(n) && n >= 0 && n <= 240)
                        next.minGapMinutes = Math.round(n);
                }
                if (patch?.splitDm !== undefined)
                    next.splitDm = patch.splitDm === true;
                if (patch?.followupMinutes !== undefined) {
                    const n = Number(patch.followupMinutes);
                    if (Number.isFinite(n) && n >= 0 && n <= 600)
                        next.followupMinutes = Math.round(n);
                }
                if (patch?.idleHours !== undefined) {
                    const n = Number(patch.idleHours);
                    if (Number.isFinite(n) && n >= 0 && n <= 72)
                        next.idleHours = Math.round(n);
                }
                writeQqOverride(next);
                return this.getQq();
            },
            /** 面板上按「现在叫醒」：走生活线闹钟同一条投递路，醒来带一眼群里最近几条。 */
            async wake() {
                if (!life?.wakeNow)
                    throw new Error('生活线没开（世界停着？）');
                await life.wakeNow();
            },
            async start() {
                if (power.running())
                    return;
                power.set(true);
                try {
                    await startMemory(true);
                    await startLife(true);
                }
                finally {
                    sources.invalidate();
                }
            },
            async stop() {
                if (!power.running())
                    return;
                power.set(false);
                await stopLife();
                try {
                    await stopMemory();
                }
                finally {
                    sources.invalidate();
                }
            },
            prompts: () => ({
                persona: readPersona(personaFile),
                worldPrompt: existsSync(worldPromptFile) ? { text: readFileSync(worldPromptFile, 'utf8'), custom: true } : { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), custom: false },
            }),
            savePersona: persona => { writePersona(personaFile, { ...readPersona(personaFile), ...persona }); sources.invalidate(); },
            setDailyBudget: yuan => { power.setDailyBudget(yuan); sources.invalidate(); },
            setSchedule: patch => { const next = schedule.save(patch); sources.invalidate(); return next; },
            setMemoryTurns: turns => { power.setMemoryTurns(turns); sources.invalidate(); },
            async setModules(patch) {
                if (patch.wechat !== undefined && !config.wechat)
                    return '没有配置微信模块（配置里 wechat: true）';
                if (patch.qq !== undefined && !config.qqNative?.enabled)
                    return '没有配置原生 QQ 通道（配置里 qqNative.enabled）';
                power.setModules(patch);
                // 刷B站不是个「进程」，开关就是定时器挂不挂；面板上一点就生效
                if (patch.bili === false)
                    bili.stop();
                if (patch.bili === true && life && power.biliEnabled())
                    bili.start();
                try {
                    if (patch.wechat === false)
                        await stopWechat();
                    if (patch.wechat === true && life)
                        await startWechat(life);
                    if (patch.qq === false)
                        stopQqNative();
                    if (patch.qq === true && life)
                        await startQqNative(life);
                    if (patch.qq === true && life && !qqNative)
                        return 'QQ 模块没能启动，请查看健康状态';
                }
                catch (error) {
                    faults.set('wechat', `微信模块没能切换：${errorText(error)}`);
                    lifeCtx.logger.error(error);
                    return `切换失败：${errorText(error)}`;
                }
                finally {
                    sources.invalidate();
                }
                faults.clear('wechat');
                return undefined;
            },
            restartWechatAdapter: async () => { if (!adapter)
                return false; try {
                await adapter.restart();
            }
            finally {
                sources.invalidate();
            } return true; },
            setWechatSettings: next => { power.setWechat(next); sources.invalidate(); },
            setArchiveScope: scope => { power.setArchiveScope(scope); sources.invalidate(); return power.restartRequired(); },
            saveWorldPrompt: text => { if (text.trim())
                durableWrite(worldPromptFile, text);
            else
                rmSync(worldPromptFile, { force: true }); },
        };
        lifeCtx.effect(() => webServer.register(consoleRoute(sources, actions, config.allowedHosts)), 'dsh-world console routes');
        if (power.running())
            await startLife(false);
    });
}
