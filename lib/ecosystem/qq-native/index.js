import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { speakerIdentity, conversationKey } from "../shared/identity.js";
import { createBridge } from "./snowluma.js";
import { createQqHome } from "./home.js";
import { createNativeBridge } from "./native-bridge.js";
import { checkFishy } from "./fishcheck.js";
/** The largest single message we accept from QQ; anything longer is cut before it reaches her. */
const MAX_INCOMING = 2_000;
/**
 * 私聊的合并窗口：连发几条时，等 5 秒没有新消息再叫醒一次，把几条并成一条。
 * 每叫醒一次都要重算一段上下文（约 5k token 未命中，几厘到一分钱），
 * 主人连发时合并能省掉好几次叫醒；单条消息只多等 5 秒。
 */
const PRIVATE_MERGE_MS = 5_000;
/** How many distinct messages we remember to drop repeats of. */
const SEEN_LIMIT = 500;
/**
 * SnowLuma 的 OneBot HTTP 口：拉群消息历史走这条。
 * 注意它和 WS 连接那条的 token 不是同一个，别混用（混了就是 401，钟永远拉不到新话）。
 */
const SNOWLUMA_HTTP = 'http://127.0.0.1:3010';
/**
 * token 不进仓库（2026-11-15 改）：优先环境变量 SNOWLUMA_HTTP_TOKEN，
 * 其次插件根目录下的 snowluma.token（在 .gitignore 里）。
 * 都没有就是空串——拉历史会 401，插件其余部分照常用。
 */
function loadSnowlumaToken() {
    if (process.env.SNOWLUMA_HTTP_TOKEN) return process.env.SNOWLUMA_HTTP_TOKEN.trim();
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const tokenFile = join(here, '..', '..', '..', 'snowluma.token');
        if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim();
    } catch (e) { /* 读不到就当没有 */ }
    return '';
}
const SNOWLUMA_HTTP_TOKEN = loadSnowlumaToken();
export function createQqNativeModule(deps) {
    const home = createQqHome({ ctx: deps.ctx, home: deps.home });
    const seen = new Set();
    const contexts = new Map();
    const answering = new Set();
    /** 私聊的合并窗口：key → { identity, parts, imageOnly, timer }。 */
    const privatePending = new Map();
    // 她自己的那条线：最后一次见到的账号。
    let lastSelfId = '';
    let client;
    let nativeBridge;
    let stopped = false;
    // 「我刚刚说过话」的记号：外面的 say.ps1 也看这个文件。
    const replyFlagFile = (() => {
        const stateFile = deps.stateFile;
        if (!stateFile)
            return null;
        return join(dirname(stateFile), 'room', 'tools', 'state', 'chat-reply.flag');
    })();
    function markSpoke() {
        if (!replyFlagFile)
            return;
        try {
            // 新装的世界可能还没有 tools/state：不先建目录的话 writeFileSync 会失败，
            // 记号写不进去，续聊窗口就永远不开——外面表现成「群里说一句就跑」（2026-11-18 查到的）。
            mkdirSync(dirname(replyFlagFile), { recursive: true });
            writeFileSync(replyFlagFile, new Date().toISOString(), 'utf8');
        }
        catch { /* 碰不动就算了，不耽误发消息 */ }
        // 我开口了：陪伴窗口重新算，连着没接的次数和这一轮叫醒数也清零；能量回一点，检查跟上。
        companionMisses = 0;
        companionWakes = 0;
        companionEnergy = Math.min(1, companionEnergy + 0.15);
        startCheck();
    }
    // 表情包给的是本地服务的地址（127.0.0.1:<端口>），端口每次启动都会变。
    // 发图前换成磁盘路径，OneBot 直接读本地文件，不依赖端口。
    // 缓存在 DSH home 下的 nekowhale-stickers\byhash；stateFile 在 world 目录里，
    // 按它上两级算会落到 <worlds>\nekowhale-stickers，永远找不到（2026-11-10 修）。
    const stickerRoots = (() => {
        const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
        const list = [join(dshHome, 'nekowhale-stickers', 'byhash')];
        if (deps.stateFile)
            list.push(resolve(dirname(deps.stateFile), '..', '..', 'nekowhale-stickers', 'byhash'));
        return [...new Set(list)];
    })();
    function localImage(value) {
        const raw = String(value || '').trim();
        if (!raw)
            return '';
        if (/^https?:\/\//i.test(raw)) {
            try {
                const url = new URL(raw);
                const prefix = '/x-nekowhale-stickers/s/';
                if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.pathname.startsWith(prefix)) {
                    const name = decodeURIComponent(url.pathname.slice(prefix.length));
                    const file = stickerRoots.map(root => join(root, name)).find(candidate => existsSync(candidate));
                    if (file)
                        return 'file:///' + file.replace(/\\/g, '/');
                    if (typeof deps.logger?.warn === 'function')
                        deps.logger.warn(`QQ 表情包文件没找到（${name}），找过：${stickerRoots.join(' ; ')}`);
                    return '';
                }
            }
            catch { /* 不是能解析的地址就按原样发 */ }
        }
        return raw;
    }
    // 面板要的那几个数自己记：传输层只交出一个 getState()，不带计数。
    const stats = {
        sent: 0, failed: 0, blocked: 0, lastEventAt: null, lastBlockedAt: null, lastError: null,
    };
    // 拨过的开关写在 stateFile 里，重载不丢；配置里那个是出厂默认。
    let overrides = {};
    let overridesRead = false;
    function readOverrides() {
        if (overridesRead)
            return;
        overridesRead = true;
        const file = deps.stateFile;
        if (!file)
            return;
        try {
            overrides = JSON.parse(readFileSync(file, 'utf8'));
        }
        catch {
            overrides = {};
        }
    }
    function writeOverrides() {
        const file = deps.stateFile;
        if (!file)
            return;
        try {
            writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
        }
        catch (error) {
            deps.logger.warn('QQ 原生通道：开关没存下来', error);
        }
    }
    const settings = () => {
        readOverrides();
        const base = deps.config();
        // 面板上改过端口就以面板为准；其余字段还是配置里那套。
        const bridge = overrides.bridge?.port === undefined ? base.bridge : { ...base.bridge, port: overrides.bridge.port };
        return {
            ...base,
            ...(overrides.autoReply === undefined ? {} : { autoReply: overrides.autoReply }),
            bridge,
        };
    };
    function remember(messageId) {
        if (!messageId)
            return true;
        if (seen.has(messageId))
            return false;
        seen.add(messageId);
        if (seen.size > SEEN_LIMIT) {
            const first = seen.values().next().value;
            if (first !== undefined)
                seen.delete(first);
        }
        return true;
    }
    // 她说出去的消息 id。有人引用她的话，引用的就是这个 id。
    const sentIds = new Set();
    function rememberSent(id) {
        const value = id == null ? '' : String(id);
        if (value === '')
            return;
        sentIds.add(value);
        if (sentIds.size > SEEN_LIMIT) {
            const oldest = sentIds.values().next().value;
            if (oldest !== undefined)
                sentIds.delete(oldest);
        }
    }
    /**
     * 群里这句是不是在叫她。
     *
     * 量过：不做这个判断时，群里没被叫到的每一句都会让她跑完一整轮、还往群里冒一条——哪怕她自己在话里
     * 写的是「这句不接」，钱和噪声都已经花了。所以只有被 @ 到、有人引用过她的话、或者命中配的关键词，
     * 才把话递到她跟前；其余只记进那个群的上下文，等她真被叫到时知道刚才在说什么。
     */
    function directedAtHer(message, config) {
        if (config.groupTrigger === 'all')
            return true;
        for (const segment of message.segments ?? []) {
            const data = segment?.data ?? {};
            if (segment?.type === 'at' && (data.qq === 'all' || String(data.qq ?? '') === message.selfId))
                return true;
            if (segment?.type === 'reply' && data.id != null && sentIds.has(String(data.id)))
                return true;
        }
        return config.groupKeywords.some(word => word !== '' && message.text.includes(word));
    }
    function allowed(identity) {
        const config = settings();
        return identity.conversationType === 'group'
            ? config.allowGroups.includes(identity.conversationId)
            : config.allowPrivate.includes(identity.speakerId.slice('qq:'.length));
    }
    function pushContext(key, message, limit) {
        const list = contexts.get(key) ?? [];
        list.push(message);
        while (list.length > Math.max(1, Math.min(limit, 20)))
            list.shift();
        contexts.set(key, list);
    }
    /** 把一段回答拆成几条短消息（QQ 上一条长文没人爱看） */
    function splitReply(text) {
        const clean = String(text || '')
            .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, '').trim())
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^#{1,6}\s*/gm, '')
            .replace(/^\s*[-*]\s+/gm, '');
        const pieces = [];
        for (const block of clean.split(/\n{2,}/)) {
            let buf = '';
            for (const line of block.split('\n')) {
                const t = line.trim();
                if (!t) continue;
                if (!buf) buf = t;
                else if ((buf + ' ' + t).length <= 80) buf += ' ' + t;
                else { pieces.push(buf); buf = t; }
            }
            if (buf) pieces.push(buf);
        }
        const out = [];
        for (const piece of pieces) {
            if (piece.length <= 90) { out.push(piece); continue; }
            for (let i = 0; i < piece.length; i += 90) out.push(piece.slice(i, i + 90));
        }
        return out.slice(0, 6);
    }
    /** 发一段话（文字 + 图），群和私聊各走各的通道。deliver 和陪伴的钟都用它。 */
    async function sendPiece(identity, piece) {
        const reply = String(piece || '').trim();
        if (!reply)
            return false;
        const isGroup = identity.conversationType === 'group';
        const conversationId = identity.conversationId;
        // 回复里可以带 [[img:url]]（自家约定的写法），也可能被写成 markdown 图片；两种都当图发。
        const stickerUrls = [
            ...[...reply.matchAll(/\[\[img:([^\]]+)\]\]/g)].map((m) => m[1].trim()),
            ...[...reply.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1].trim()),
        ].map(localImage).filter(Boolean);
        const textOnly = reply.replace(/\[\[img:[^\]]+\]\]/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
        for (const chunk of splitReply(textOnly)) {
            if (isGroup) {
                rememberSent((await client?.sendGroup(conversationId, chunk))?.messageId);
                lastSpokeGroupId = String(conversationId);
                markSpoke();
            }
            else
                rememberSent((await client?.sendPrivate(conversationId, chunk))?.messageId);
            await new Promise((r) => setTimeout(r, 400));
        }
        for (const sticker of stickerUrls) {
            await new Promise((r) => setTimeout(r, 300));
            const parts = [{ type: 'image', file: sticker }];
            if (isGroup) {
                rememberSent((await client?.sendGroup(conversationId, parts))?.messageId);
                lastSpokeGroupId = String(conversationId);
                markSpoke();
            }
            else
                rememberSent((await client?.sendPrivate(conversationId, parts))?.messageId);
        }
        stats.sent += 1;
        return true;
    }
    /** 她在说「我不接」而不是在说话：整段就是一个括号（写理由也算）。只拦括号，不拦词。 */
    function isMetaReply(text) {
        const value = String(text || '').trim();
        if (!value)
            return true;
        return /^[（(][^）)]*[）)]$/.test(value);
    }
    /** 插件只递话、递图，外加一句「接不接随你」；怎么说、回不回，是人设那边的事。 */
    const GROUP_NOTICE = '群聊旁听：这是群里的话，想接就接、不想接就不接，都算你的判断。不想接的时候别直接空着——写一句带括号的话，说明为什么（比如「（这图我不接，看不懂）」「（这话不接）」），而且要整条只有这一个括号、括号外面一个字都不带，插件才会整条拦下、不发到群里；如果括号后面还接着别的话，会连同那些话一起发出去。写清楚理由，对方在 GUI 里能看到你是怎么想的。';
    // 陪伴窗口：我说话后的 N 分钟里，群里谁接话都算在跟我聊。窗口时长走设置；
    // 一轮最多 20 次、连着 3 次没接就收，是写死的省钱闸；第 20 次让她自己说句去歇会儿。
    // 节奏不是匀速的：带一个「能量」，说一句扣一点、说得越长扣得越多、被 @ 回一点，
    // 能量低时间隔自然拉长——像人一样越聊越懒，被叫才精神。
    const COMPANION_MAX_WAKES = 20;
    let companionMisses = 0;
    let companionWakes = 0;
    let companionLastWake = 0;
    let companionEnergy = 1;
    const COMPANION_BASE_COST = 0.09;
    const COMPANION_LENGTH_COST = 1 / 1500;
    const COMPANION_RECOVER = 0.05;
    const COMPANION_AT_BOOST = 0.35;
    const COMPANION_MIN_ENERGY = 0.12;
    /** 这一轮里已经处理过的消息 id：即时投递和 续聊检查靠它互相同步，同一句只递一次。 */
    let companionSeen = new Set();
    /** 刚才开口的那个群：续聊窗口只盯它，配置里多个群时也不会认错（2026-11-18 修，之前固定只盯 allowGroups[0]）。 */
    let lastSpokeGroupId = '';
    function lastSpokeAt() {
        if (!replyFlagFile)
            return 0;
        try {
            return statSync(replyFlagFile).mtimeMs;
        }
        catch {
            return 0;
        }
    }
    function companionWindowMs() {
        const minutes = Number(settings().silenceMinutes ?? 5);
        return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000;
    }
    function companionGapMs() {
        const base = Number(settings().wakeGapSeconds ?? 20);
        const seconds = Number.isFinite(base) && base >= 3 ? base : 20;
        // 能量满：基础间隔；越累越慢（最慢约 3.2 倍），被 @ 回能量后自然又快起来。
        const tired = 1 - Math.min(1, Math.max(0, companionEnergy));
        return Math.round(seconds * 1000 * (1 + tired * 2.2));
    }
    // 群聊背景：被叫到时拉最近 30 条。图只存最新那一张——图多了全拉进来太费白饭；
    // 想看别的，等她说要回谁的话时再单独去翻那句上面那张。
    const imageCache = new Map();
    async function saveGroupImage(data, dir) {
        const url = String(data?.url || '');
        if (!url)
            return '';
        const cached = imageCache.get(url);
        if (cached)
            return cached;
        try {
            mkdirSync(dir, { recursive: true });
            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok)
                return '';
            const buf = Buffer.from(await res.arrayBuffer());
            // 按文件内容认格式和动不动，不靠扩展名：QQ 给的 file 字段经常没有后缀。
            const info = sniffImage(buf);
            const file = join(dir, `${Date.now()}-${Math.random().toString(16).slice(2, 6)}.${info.ext}`);
            writeFileSync(file, buf);
            const shrunk = await shrinkGroupImage(file, info.kind);
            trimGroupImages(dir, 30);
            imageCache.set(url, shrunk);
            return shrunk;
        }
        catch {
            return '';
        }
    }
    /** 认格式：gif 是动图；webp/png 里带动画标记的也是动图，别压成静态。 */
    function sniffImage(buf) {
        const head = (start, end) => (buf.length >= end ? buf.subarray(start, end).toString('ascii') : '');
        if (head(0, 4) === 'GIF8')
            return { ext: 'gif', kind: 'gif' };
        if (head(0, 4) === 'RIFF' && head(8, 12) === 'WEBP') {
            const animated = buf.includes(Buffer.from('ANIM')) || buf.includes(Buffer.from('ANMF'));
            return { ext: 'webp', kind: animated ? 'animated' : 'static' };
        }
        if (buf.length > 8 && buf[0] === 0x89 && head(1, 4) === 'PNG')
            return { ext: 'png', kind: buf.includes(Buffer.from('acTL')) ? 'animated' : 'static' };
        if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
            return { ext: 'jpg', kind: 'static' };
        if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4D)
            return { ext: 'bmp', kind: 'static' };
        return { ext: 'jpg', kind: 'static' };
    }
    /** 存完一张就清一次：群里图多，只留最近 30 张（开场一次拉 30 条够看）。 */
    function trimGroupImages(dir, keep) {
        try {
            const files = readdirSync(dir)
                .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
                .sort((a, b) => b.at - a.at);
            for (const one of files.slice(keep)) {
                try { rmSync(join(dir, one.name), { force: true }); }
                catch { /* 删不掉就下次再删 */ }
            }
        }
        catch { /* 清不动就算了 */ }
    }
    /** ffmpeg 在不在 PATH 里要看应用怎么起的；先试 PATH，再在 winget 安装目录里找。 */
    let ffmpegBins;
    function findFfmpeg() {
        if (ffmpegBins)
            return ffmpegBins;
        const bins = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
        try {
            const root = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
            if (existsSync(root)) {
                for (const dir of readdirSync(root)) {
                    if (!/^Gyan\.FFmpeg/i.test(dir))
                        continue;
                    const base = join(root, dir);
                    for (const sub of readdirSync(base)) {
                        const exe = join(base, sub, 'bin', 'ffmpeg.exe');
                        if (existsSync(exe))
                            bins.unshift(exe);
                    }
                }
            }
        }
        catch { /* 找不到就只剩 PATH 里的 */ }
        ffmpegBins = bins;
        return bins;
    }
    /** 依次试几个 ffmpeg 路径，哪个跑通算哪个。 */
    function runFfmpeg(args) {
        return runBinary(findFfmpeg(), args);
    }
    /** 动画 WebP / APNG 用 Pillow 重压（ffmpeg 解不了动画 WebP）：自带运行时里保证有 Pillow。 */
    const PY_HELPER = fileURLToPath(new URL('./imgshrink.py', import.meta.url));
    let pythonBins;
    function findPython() {
        if (pythonBins)
            return pythonBins;
        const bins = [];
        try {
            const bundled = join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
            if (existsSync(bundled))
                bins.push(bundled);
        }
        catch { /* 没找到就用 PATH */ }
        if (process.env.DSH_PYTHON)
            bins.push(process.env.DSH_PYTHON);
        bins.push('python', 'py');
        pythonBins = bins;
        return bins;
    }
    function runPython(args) {
        return runBinary(findPython(), args);
    }
    function runBinary(bins, args) {
        return new Promise((resolve) => {
            let index = 0;
            const attempt = () => {
                if (index >= bins.length)
                    return resolve(false);
                let child;
                try {
                    child = spawn(bins[index++], args, { windowsHide: true });
                }
                catch {
                    return attempt();
                }
                let settled = false;
                const finish = (ok) => {
                    if (settled)
                        return;
                    settled = true;
                    if (ok)
                        resolve(true);
                    else
                        attempt();
                };
                child.on('error', () => finish(false));
                child.on('exit', (code) => finish(code === 0));
            };
            attempt();
        });
    }
    /** 静图缩到 512 宽 jpg；动图（gif、动画 webp、APNG）统一转动画 WebP，变小才换。 */
    async function shrinkGroupImage(file, kind = 'static') {
        const animated = kind === 'gif' || kind === 'animated';
        const target = animated
            ? file.replace(/\.[a-z0-9]+$/i, '.webp')
            : `${file.replace(/\.[a-z0-9]+$/i, '')}.jpg`;
        // 目标可能和原文件同名：ffmpeg 不接受输入输出同一个文件，先写临时名再替换。
        // 原来的写法会让“没变大”的判断把原图删掉——群里 jpg 图就是这么消失的。
        const out = target === file ? `${target}.tmp.${animated ? 'webp' : 'jpg'}` : target;
        // gif 用 ffmpeg 转；动画 WebP / APNG 用 Pillow；静图用 ffmpeg 缩 jpg。
        const ok = kind === 'animated'
            ? await runPython([PY_HELPER, file, out, '50', '320'])
            : await runFfmpeg(animated
                ? ['-y', '-loglevel', 'error', '-i', file, '-vf', "fps=10,scale='min(320,iw)':-2:flags=lanczos", '-c:v', 'libwebp', '-lossless', '0', '-q:v', '55', '-loop', '0', out]
                : ['-y', '-loglevel', 'error', '-i', file, '-vf', "scale='min(512,iw)':-2", '-q:v', '5', out]);
        try {
            if (!ok || !existsSync(out)) {
                if (out !== file)
                    rmSync(out, { force: true });
                return file;
            }
            // 只有真的变小才换；原图已经压得很好时，重编码反而更大，别做亏本买卖。
            if (statSync(out).size >= statSync(file).size) {
                if (out !== file)
                    rmSync(out, { force: true });
                return file;
            }
        }
        catch {
            return file;
        }
        try {
            if (out !== file)
                rmSync(file, { force: true });
            if (out !== target)
                renameSync(out, target);
        }
        catch { /* 挪不过去就先把临时文件留着，总比把原图删了强 */ }
        return target;
    }
    function groupImageDir() {
        const stateFile = deps.stateFile;
        return stateFile ? join(dirname(stateFile), 'room', '群图') : '';
    }
    /**
     * 只看最新一张：群里图一多，全存全列没意义，还费白饭。
     * 从后往前找最近一条带图的，存那张，返回它在列表里的位置。
     */
    async function pickLatestImage(ones, dir) {
        for (let index = ones.length - 1; index >= 0; index -= 1) {
            const segments = (ones[index]?.message || []).filter((seg) => seg?.type === 'image');
            if (!segments.length)
                continue;
            const saved = dir ? await saveGroupImage(segments[segments.length - 1].data, dir) : '';
            if (saved)
                return { file: saved, index };
        }
        return undefined;
    }
    async function buildBackground(groupId) {
        let list = [];
        try {
            const res = await fetch(`${SNOWLUMA_HTTP}/get_group_msg_history`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${SNOWLUMA_HTTP_TOKEN}` },
                body: JSON.stringify({ group_id: Number(groupId), count: 30 }),
                signal: AbortSignal.timeout(8000),
            });
            list = (await res.json())?.data?.messages || [];
        }
        catch {
            return '';
        }
        const dir = deps.stateFile ? join(dirname(deps.stateFile), 'room', '群图') : '';
        const newest = await pickLatestImage(list, dir);
        const lines = [];
        for (let index = 0; index < list.length; index += 1) {
            const one = list[index];
            const when = new Date(Number(one.time || 0) * 1000).toTimeString().slice(0, 5);
            const name = one.sender?.card || one.sender?.nickname || String(one.sender?.user_id || '');
            const parts = [];
            const imageSegments = (one.message || []).filter((seg) => seg?.type === 'image');
            let imagesSeen = 0;
            for (const seg of one.message || []) {
                if (seg.type === 'text')
                    parts.push(seg.data?.text || '');
                else if (seg.type === 'at')
                    parts.push(`@${seg.data?.qq}`);
                else if (seg.type === 'image') {
                    imagesSeen += 1;
                    const keep = newest && newest.index === index && imagesSeen === imageSegments.length;
                    parts.push(keep ? `[图 存于 ${newest.file}]` : '[图]');
                }
            }
            const text = parts.join(' ').trim();
            if (text)
                lines.push(`${when} ${name}：${text}`);
        }
        return lines.length ? `【刚才群里在聊】（图只存了最新一张，别的图要看再翻）\n${lines.join('\n')}` : '';
    }
    /** 群消息的 identity：即时投递和 续聊检查都用这套。 */
    function groupIdentityOf(one, groupId) {
        try {
            return speakerIdentity({
                channel: 'qq',
                accountId: lastSelfId || String(one.self_id ?? '') || '0',
                speakerId: `qq:${one.sender?.user_id || '0'}`,
                ...(one.sender?.card || one.sender?.nickname ? { speakerName: one.sender?.card || one.sender?.nickname } : {}),
                conversationId: groupId,
                conversationType: 'group',
                conversationName: `群 ${groupId}`,
                ...(one.message_id != null ? { platformMessageId: String(one.message_id) } : {}),
            });
        }
        catch {
            return undefined;
        }
    }
    /**
     * 要回谁的话，就顺带看一眼那句话上面那张图：图和话对不对得上，得看了才知道。
     * 只在群聊、不是纯图消息时用；拿不到就悄悄算了，别为一张图卡住回话。
     */
    async function imageAboveHint(identity, body) {
        try {
            if (identity.conversationType !== 'group' || !identity.platformMessageId)
                return '';
            const res = await fetch(`${SNOWLUMA_HTTP}/get_group_msg_history`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${SNOWLUMA_HTTP_TOKEN}` },
                body: JSON.stringify({ group_id: Number(identity.conversationId), count: 20 }),
                signal: AbortSignal.timeout(3000),
            });
            const list = (await res.json())?.data?.messages || [];
            const at = list.findIndex((one) => String(one.message_id) === String(identity.platformMessageId));
            if (at < 0)
                return '';
            // 图和话的关系是「挨着」：图在紧接着的上一句，才是配这张图的话；隔了好几条还往上翻的图，
            // 通常跟这句话没关系。唯一的例外是同一个人连着说了好几句——那几句是一整块，
            // 块最上面那句才挨着图，所以只在同一个人的连续发言里往上找。
            const speakerOf = (one) => String(one?.sender?.user_id ?? '');
            const imagesOf = (one) => (one?.message || []).filter((seg) => seg?.type === 'image');
            const quoteId = (list[at]?.message || []).find((seg) => seg?.type === 'reply')?.data?.id;
            const quoteAt = quoteId == null ? -1 : list.findIndex((one) => String(one.message_id) === String(quoteId));
            let pickAt = -1;
            if (imagesOf(list[at]).length)
                pickAt = at; // 这句自己带图
            else if (quoteAt >= 0 && imagesOf(list[quoteAt]).length)
                pickAt = quoteAt; // 这句话是在回某条消息，就看被回的那条
            else {
                const me = speakerOf(list[at]);
                for (let index = at - 1, steps = 0; index >= 0 && steps < 6; index -= 1, steps += 1) {
                    if (imagesOf(list[index]).length) {
                        pickAt = index;
                        break;
                    }
                    // 往上碰到别人说的话就停：再往上的图跟这句话没关系
                    if (speakerOf(list[index]) !== me)
                        break;
                }
            }
            if (pickAt < 0)
                return '';
            const segments = imagesOf(list[pickAt]);
            const saved = await saveGroupImage(segments[segments.length - 1].data, groupImageDir());
            if (!saved)
                return '';
            if (String(body).includes(saved))
                return `这句话上面挨着的图，就是刚给你的最新一张：${saved}——图和话要挨着才可能有关；对得上就一起回，对不上就只回话；不想接就写一句带括号的理由（插件不会发出去）。`;
            return `这句话上面挨着的那张图是：${saved}——离得远的图通常跟这句话没关系，别硬凑；对得上就一起回，对不上就只回话；不想接就写一句带括号的理由（插件不会发出去）。`;
        }
        catch {
            return '';
        }
    }
    /**
     * 读空气：把「刚才谁在说话、聊了点什么」缩成一句，跟在群消息前面递过去。
     * 只给摘要，不替她判断接不接——接不接还是她自己看。
     */
    function groupVibe(context) {
        const recent = Array.isArray(context) ? context.slice(-6) : [];
        if (!recent.length)
            return '';
        const speakers = [...new Set(recent.map(one => one?.identity?.speakerName).filter(Boolean))];
        const lines = recent.slice(-3).map((one) => {
            const name = one?.identity?.speakerName || '群友';
            return `${name}：${String(one?.text || '').replace(/\s+/g, ' ').slice(0, 40)}`;
        });
        const who = speakers.length ? `最近说话的人：${speakers.slice(0, 8).join('、')}` : '';
        const what = lines.length ? `刚在聊：${lines.join(' / ')}` : '';
        return [who, what].filter(Boolean).length ? `【这个群此刻】${[who, what].filter(Boolean).join('；')}` : '';
    }
    /** 把一段话问给群会话，回的话发到群里。被叫到时和 续聊检查都走这一条。 */
    async function askAndSend(identity, body, context, isImageOnly) {
        const key = conversationKey(identity);
        answering.add(key);
        try {
            const isGroup = identity.conversationType === 'group';
            // 群会话第一次叫醒（手里还没有聊天记录）时，先拉 30 条背景。
            // 群聊手记（认人）走系统提示，每轮都在，不在这儿重复塞。
            const firstWake = isGroup && context.length === 0;
            const background = firstWake ? await buildBackground(identity.conversationId) : '';
            // 每轮带一句「群里此刻」：谁在说、刚在聊什么。只给材料，接不接还是她自己看。
            const vibe = isGroup ? groupVibe(context) : '';
            // 要回某人的话时，顺带把他上面那张图也看一眼——图和话有没有关系，看了才知道。
            const above = isGroup && !isImageOnly ? await imageAboveHint(identity, body) : '';
            // 这一轮的最后一次：让她自己想个说法跟大伙打声招呼去歇着。
            const lastOne = isGroup && !isImageOnly && companionWakes >= COMPANION_MAX_WAKES - 1;
            // 鱼八股规则前移到生成之前：回的话会直接发出去，先自己扫一遍再开口，比发出去再拦回来重说省一次任务。
            // 括号这里的说法要和 GROUP_NOTICE 对上：动作括号（摸摸头/笑）不要用，但「不想接」时整条只留一个括号写理由那种不算。
            const fishyHint = '\n（回的话会直接发出去，发之前自己扫一遍：别用「这条我认 / 这话我认 / 这句我认 / 我记下了 / 我收下了」这类句子，也别用括号写角色动作（比如「（尾巴摇摇）」「（蹭蹭）」）、别用总结腔、对仗腔——像鱼八股会被拦下来重说一遍。不想接时整条只留一个括号写理由，那种不算鱼八股。）';
            const notice = (isGroup ? GROUP_NOTICE + (background ? '\n' + background : '') + (vibe ? '\n' + vibe : '') + (above ? '\n' + above : '') + (lastOne ? '\n（这是这一轮的第 20 次了。找个自然的理由说你要去歇会儿，顺便告诉大家有事再叫你。）' : '') : '') + fishyHint;
            if (isGroup && !isImageOnly) {
                companionWakes += 1;
                companionLastWake = Date.now();
            }
            // 只发这一轮最后说的那段话：中途的"图不回"这种过程话留在 GUI 里，别漏到群里。
            const answer = await home.ask(body, identity, context, undefined, notice);
            let said = String(answer.text || '').trim();
            // 硬规则兜底：像鱼八股的先递回去提醒一次，换不换她自己定，不卡死。
            // 规则来自 fishcheck.js（移植自 fishtalk 的硬规则），语料相似度留在 fishtalk。
            if (said && !isMetaReply(said) && settings().fishyCheck !== false) {
                const verdict = checkFishy(said);
                if (verdict.problems.length) {
                    try {
                        const retry = await home.ask(
                            `（插件提醒，不是群里的话）你刚要说的是：「${said}」\n这句有点鱼八股：${verdict.problems.join('；')}。\n换一句像平常说话的再说一遍；不想换就原样回。`,
                            identity, [], undefined, '');
                        const again = String(retry?.text || '').trim();
                        // 重想时她要是回了纯括号（不想接），就按不接处理，别把被拦的原句再发出去。
                        if (again)
                            said = again;
                    }
                    catch { /* 重想没成，照原句发 */ }
                }
            }
            // 「（没接话）」「（图不回）」这种是它在说自己不接，不是给人看的话——别发。
            if (!isMetaReply(said))
                await sendPiece(identity, said);
            // 递过来她没接：连着 3 次就收，别硬陪。
            if (!said || isMetaReply(said))
                companionMisses += 1;
            else {
                companionMisses = 0;
                // 说一句扣一点能量：基础消耗 + 长度惩罚，说得越长越累，下一拍就慢一点。
                if (isGroup) {
                    const chars = Array.from(said).length;
                    companionEnergy = Math.max(0, companionEnergy - (COMPANION_BASE_COST + chars * COMPANION_LENGTH_COST));
                }
            }
            // 她那句话记成她自己说的：不然后面拿这段上下文问她「刚才聊到哪了」时，
            // 她说过的会被当成对方说的（home.ts 里按 speakerId 判 role 为 assistant）。
            const herIdentity = speakerIdentity({
                channel: 'qq',
                accountId: identity.accountId,
                speakerId: `qq:${identity.accountId}`,
                conversationId: identity.conversationId,
                conversationType: identity.conversationType,
            });
            // 上下文里只记最终发出去的那句：审核前被拦下的版本不算她说过的话。
            pushContext(key, { id: answer.id, occurredAt: new Date().toISOString(), text: said, identity: herIdentity }, context_messages_limit());
            return said;
        }
        finally {
            answering.delete(key);
        }
    }
    function context_messages_limit() {
        return Number(settings().contextMessages ?? 6) || 6;
    }
    /**
     * 私聊的合并窗口：这条先记着，5 秒内又来一条就重新计时，等安静下来再合成一次叫醒。
     * 群聊不合并——群里每句的语气是分开的，且群聊本来就有 续聊检查。
     */
    function deferPrivate(identity, body, imageOnly) {
        const key = conversationKey(identity);
        const pending = privatePending.get(key) ?? { identity, parts: [], imageOnly: true, timer: null };
        pending.identity = identity;
        pending.parts.push(body);
        pending.imageOnly = pending.imageOnly && imageOnly;
        if (pending.timer)
            clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
            privatePending.delete(key);
            const merged = pending.parts.join('\n');
            askAndSend(pending.identity, merged, contexts.get(key) ?? [], pending.imageOnly).catch((error) => {
                stats.failed += 1;
                stats.lastError = error instanceof Error ? error.message : String(error);
                deps.logger.warn(`QQ 回复 ${key} 失败: ${stats.lastError}`);
            });
        }, PRIVATE_MERGE_MS);
        pending.timer.unref?.();
        privatePending.set(key, pending);
    }
    // 续聊窗口：我说话后的窗口里，隔一会儿看一眼群里有没有新话；有就一次递进来，没有就不叫醒。
    // 不是固定节奏：两次检查的间隔由「能量」决定，越聊越累就越慢。
    let checkTimer = null;
    /** 看记号文件：我在家用 say.ps1 说话时插件不知道，隔一会儿看一眼，替我把续聊窗口打开。 */
    let flagWatch = null;
    let checkAligned = false;
    let checkStartAt = 0;
    function stopCheck() {
        if (checkTimer) {
            clearTimeout(checkTimer);
            checkTimer = null;
        }
        checkAligned = false;
        checkStartAt = 0;
    }
    /** 窗口还该不该继续：没过期、没到上限、能量没耗尽、开关还开着。 */
    function checkAlive() {
        if (stopped)
            return false;
        const spoke = lastSpokeAt();
        if (!spoke || Date.now() - spoke > companionWindowMs())
            return false;
        if (companionMisses >= 3 || companionWakes >= COMPANION_MAX_WAKES || companionEnergy <= COMPANION_MIN_ENERGY)
            return false;
        const config = settings();
        return Boolean(config.enabled && config.autoReply && (lastSpokeGroupId || String((config.allowGroups ?? [])[0] ?? '')));
    }
    function scheduleCheck(waitMs) {
        if (stopped || checkTimer)
            return;
        const delay = typeof waitMs === 'number' ? waitMs : companionGapMs();
        checkTimer = setTimeout(async () => {
            checkTimer = null;
            if (!checkAlive()) {
                stopCheck();
                return;
            }
            // 每拍慢慢回一点能量：歇一会儿就缓过来，但不会比刚开口时更有劲。
            companionEnergy = Math.min(1, companionEnergy + COMPANION_RECOVER);
            try {
                await companionCheck();
            }
            catch { /* 这一拍没看成，下一拍再来 */ }
            if (!checkTimer && checkAlive())
                scheduleCheck();
        }, delay);
        checkTimer.unref?.();
    }
    function startCheck() {
        if (checkTimer || stopped)
            return;
        checkAligned = false;
        // 对齐只针对「开始检查之前」的老消息；之后到达的哪怕还在头一拍里，也算新话。
        // 对齐点用「上次开口的时间」，不用 now：重启后从记号文件恢复续聊窗口时，从我开口到
        // 窗口重新跑起来这段里群友说的话本来就该递进来，用 now 会把它们当成老消息标掉，
        // 之后永远递不上来（2026-11-17 群里反馈的「说一句就走了」）。
        checkStartAt = lastSpokeAt() || Date.now();
        scheduleCheck();
    }
    async function companionCheck() {
        if (!checkAlive()) {
            stopCheck();
            return;
        }
        const config = settings();
        // 续聊只盯刚才开口的那个群；没有记录（重启后）再退回配置里的第一个群。
        const groupId = lastSpokeGroupId || String((config.allowGroups ?? [])[0] ?? '');
        let list = [];
        try {
            const res = await fetch(`${SNOWLUMA_HTTP}/get_group_msg_history`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${SNOWLUMA_HTTP_TOKEN}` },
                body: JSON.stringify({ group_id: Number(groupId), count: 20 }),
                signal: AbortSignal.timeout(6000),
            });
            list = (await res.json())?.data?.messages || [];
        }
        catch {
            return;
        }
        if (!checkAligned) {
            // 只把「开始检查之前」的老消息标掉；检查开始后才到的话，头一拍也要递。
            for (const one of list) {
                if (Number(one.time || 0) * 1000 < checkStartAt - 1000)
                    companionSeen.add(String(one.message_id));
            }
            checkAligned = true;
        }
        const selfId = String(lastSelfId || '');
        // 自己的号可能有两条线索：记着的 lastSelfId，和消息里带的 self_id。都算“自己”，别把自己说的话递回来。
        const ownIds = new Set([selfId, ...list.map((one) => String(one.self_id ?? ''))].filter(Boolean));
        const fresh = list.filter((one) => !companionSeen.has(String(one.message_id)) && !ownIds.has(String(one.sender?.user_id || '')));
        // 新话里也只存最新一张图，跟被 @ 时一个样
        const newest = await pickLatestImage(fresh, groupImageDir());
        const spokenOnes = [];
        let imageOnly = true;
        for (let index = 0; index < fresh.length; index += 1) {
            const one = fresh[index];
            const parts = [];
            const imageSegments = (one.message || []).filter((seg) => seg?.type === 'image');
            let imagesSeen = 0;
            for (const seg of one.message || []) {
                if (seg.type === 'text') {
                    parts.push(seg.data?.text || '');
                    if (String(seg.data?.text || '').trim())
                        imageOnly = false;
                }
                else if (seg.type === 'at')
                    parts.push(`@${seg.data?.qq}`);
                else if (seg.type === 'image') {
                    imagesSeen += 1;
                    const keep = newest && newest.index === index && imagesSeen === imageSegments.length;
                    parts.push(keep ? `[图：${newest.file}]` : '[图]');
                }
            }
            const text = parts.join(' ').trim();
            if (text)
                spokenOnes.push({ text, one });
        }
        if (!spokenOnes.length)
            return;
        const last = spokenOnes[spokenOnes.length - 1].one;
        const identity = groupIdentityOf(last, groupId);
        if (!identity)
            return;
        const key = conversationKey(identity);
        // 正在回这个群：这一拍不递、也不标记，下一拍再拉——不然这批话会被当成「处理过」吞掉。
        if (answering.has(key))
            return;
        for (const one of fresh)
            companionSeen.add(String(one.message_id));
        // 一拍里攒下的新话合成一条；这中间可能是好几个人说的。
        // identity 只能带最后一个发言人的，所以每一句前面都把名字写上，别让「谁在说」丢掉
        // （2026-11-17 反馈：合并后全是裸句子，分不清哪句是谁说的）。
        const merged = spokenOnes.map((item) => {
            const who = item.one?.sender?.card || item.one?.sender?.nickname || String(item.one?.sender?.user_id || '');
            return who ? `${who}：${item.text}` : item.text;
        }).join('\n');
        await askAndSend(identity, merged, contexts.get(key) ?? [], imageOnly);
    }
    async function deliver(message) {
        if (stopped)
            return;
        const config = settings();
        if (!config.enabled)
            return;
        const messageId = message.messageId;
        if (!remember(messageId))
            return;
        const selfId = message.selfId;
        const userId = message.userId;
        // 自己的号和自己的话都要先记下来：自己发的消息回灌也应该认得出是自己，
        // 不然重启后第一句会把自己的话当成新消息，还会用 accountId=0 开出一条新的群会话。
        lastSelfId = selfId || lastSelfId;
        // Her own words come back through the same socket; answering them would be talking to herself.
        if (!userId || userId === selfId)
            return;
        const text = message.text.trim().slice(0, MAX_INCOMING);
        if (!text)
            return;
        const isGroup = message.kind === 'group';
        const conversationId = isGroup ? message.groupId ?? '' : userId;
        if (!conversationId)
            return;
        stats.lastEventAt = new Date().toISOString();
        // 有人说话了：房间安静了多久她得记得，顺带记住自己这个号是哪个。
        // 引擎开没开都得记 —— 不然开关一拨开，它以为「一直没人说过话」。
        const speakerName = message.sender?.card || message.sender?.nickname || '';
        let identity;
        try {
            identity = speakerIdentity({
                channel: 'qq',
                // self_id 时有时无：见过一次就记住（lastSelfId），别让空值把身份写成账号 0。
                accountId: lastSelfId || selfId || '0',
                speakerId: `qq:${userId}`,
                ...(speakerName ? { speakerName } : {}),
                conversationId,
                conversationType: isGroup ? 'group' : 'private',
                ...(isGroup ? { conversationName: `群 ${conversationId}` } : {}),
                ...(messageId ? { platformMessageId: messageId } : {}),
            });
        }
        catch (error) {
            deps.logger.warn('QQ 消息身份不合法:', error);
            return;
        }
        // 不在白名单也算「到过」：不然分不清「消息根本没送到」和「送到了但被白名单挡下」——
        // 明天拿手机发一条时，这两件事的区别就是全部的意义。
        if (!allowed(identity)) {
            stats.blocked += 1;
            stats.lastBlockedAt = new Date().toISOString();
            return;
        }
        const key = conversationKey(identity);
        // 纯图、纯表情：图本身也是话——存下来，图信息进上下文；递不递交给 续聊检查。
        const spoken = text.replace(/\[图片\]|\[表情[^\]]*\]|\[语音\]|\[视频\]|\[文件\]/g, '').trim();
        let body = text;
        let imageOnly = false;
        if (!spoken) {
            const images = (message.segments ?? []).filter((seg) => seg?.type === 'image');
            // 只给最新一张：图多的时候别全塞给她看。
            const latest = images[images.length - 1];
            const saved = latest ? await saveGroupImage(latest.data, groupImageDir()) : '';
            if (!saved) {
                pushContext(key, { id: messageId || String(Date.now()), occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
                return;
            }
            imageOnly = true;
            body = `[群友发来 ${images.length} 张图，最新这张：${saved}——想接就看看，不想接就写一句带括号的理由说明]`;
        }
        else {
            // 文字+图同一条：文字照旧，图只给最新一张的路径，别让图悄悄丢了。
            const images = (message.segments ?? []).filter((seg) => seg?.type === 'image');
            if (images.length) {
                const saved = await saveGroupImage(images[images.length - 1].data, groupImageDir());
                if (saved)
                    body = `${body} [图：${saved}]`;
            }
        }
        if (!config.autoReply || stopped) {
            pushContext(key, { id: messageId || `${Date.now()}`, occurredAt: new Date().toISOString(), text: body, identity }, config.contextMessages);
            return;
        }
        const context = contexts.get(key) ?? [];
        // 群聊：被叫到就立刻回；其余先记着，交给 续聊检查，别每句都叫醒。
        if (isGroup && !directedAtHer(message, config)) {
            pushContext(key, { id: messageId || String(Date.now()), occurredAt: new Date().toISOString(), text: body, identity }, config.contextMessages);
            return;
        }
        // 被叫到的群消息：跟检查那边说一声，同一句别递两次。
        if (isGroup && messageId)
            companionSeen.add(String(messageId));
        // 被叫到了：精神一点，能量回一截，窗口接着跑（不用等下一拍）。
        if (isGroup) {
            companionEnergy = Math.min(1, companionEnergy + COMPANION_AT_BOOST);
            companionMisses = 0;
            startCheck();
        }
        // 私聊：先进合并窗口，安静 5 秒再叫醒（连发几条只算一轮）。
        if (!isGroup) {
            deferPrivate(identity, body, imageOnly);
            return;
        }
        try {
            await askAndSend(identity, body, context, imageOnly);
        }
        catch (error) {
            stats.failed += 1;
            stats.lastError = error instanceof Error ? error.message : String(error);
            deps.logger.warn(`QQ 回复 ${key} 失败: ${stats.lastError}`);
        }
    }
    /**



  /**
   * 阳台：给机器上别的程序留的一条线。
   *
   * 和 QQ 那条完全分开 —— 它是外面递话进来，不是 QQ 消息。一条线一间屋子（会话键里带着
   * `qq-bridge`），所以它跟她别的会话互不打扰。口令落在世界目录（qq-bridge.json），
   * 重启 DSH 对面那份配置不用改。
   */
    function startBridge(config) {
        if (nativeBridge || !config.bridge.port)
            return;
        nativeBridge = createNativeBridge({
            ctx: deps.ctx,
            session: identity => deps.home(identity),
            config: () => {
                const live = settings().bridge;
                return { port: live.port, token: live.token, title: live.title, contextMessages: live.contextMessages };
            },
            worldDir: deps.stateFile ? dirname(deps.stateFile) : process.cwd(),
            script: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qq-line.js'),
            log: (message) => deps.logger.info(message),
        });
        void nativeBridge.start().catch((error) => deps.logger.error('阳台没能开起来', error));
    }
    return {
        status() {
            const config = settings();
            return {
                enabled: config.enabled,
                connected: client?.getState() === 'online',
                url: config.wsUrl,
                allowPrivate: config.allowPrivate.length,
                allowGroups: config.allowGroups.length,
                autoReply: config.autoReply,
                bindHomeSession: config.bindHomeSession,
                bridge: nativeBridge?.status() ?? null,
                groupTrigger: config.groupTrigger,
                conversations: contexts.size,
                answering: answering.size,
                lastEventAt: stats.lastEventAt,
                blocked: stats.blocked,
                lastBlockedAt: stats.lastBlockedAt,
                lastError: stats.lastError,
                sent: stats.sent,
                failed: stats.failed,
            };
        },
        /** 醒来时给她看一眼群里最近几条：文字为主，图只留最新一张的路径（跟别的入口一个原则）。 */
        async digest(count = 30) {
            try {
                const config = settings();
                const groupId = String((config.allowGroups ?? [])[0] ?? '');
                if (!config.enabled || !groupId)
                    return '';
                const res = await fetch(`${SNOWLUMA_HTTP}/get_group_msg_history`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${SNOWLUMA_HTTP_TOKEN}` },
                    body: JSON.stringify({ group_id: Number(groupId), count }),
                    signal: AbortSignal.timeout(4000),
                });
                const list = (await res.json())?.data?.messages || [];
                const newest = await pickLatestImage(list, groupImageDir());
                const lines = [];
                for (let index = 0; index < list.length; index += 1) {
                    const one = list[index];
                    const when = new Date(Number(one.time || 0) * 1000).toTimeString().slice(0, 5);
                    const name = one.sender?.card || one.sender?.nickname || String(one.sender?.user_id || '');
                    const parts = [];
                    const imageSegments = (one.message || []).filter((seg) => seg?.type === 'image');
                    let imagesSeen = 0;
                    for (const seg of one.message || []) {
                        if (seg.type === 'text')
                            parts.push(seg.data?.text || '');
                        else if (seg.type === 'at')
                            parts.push(`@${seg.data?.qq}`);
                        else if (seg.type === 'image') {
                            imagesSeen += 1;
                            const keep = newest && newest.index === index && imagesSeen === imageSegments.length;
                            parts.push(keep ? `[图：${newest.file}]` : '[图]');
                        }
                    }
                    const text = parts.join(' ').trim().slice(0, 140);
                    if (text)
                        lines.push(`${when} ${name}：${text}`);
                }
                if (!lines.length)
                    return '';
                return `【群里最近 ${lines.length} 条】（只有文字和最新一张图；别的图要看再翻）\n${lines.join('\n')}\n看完想接就接，不想接就写一句带括号的理由（插件不会发出去），回不回都算你的。`;
            }
            catch {
                return '';
            }
        },
        /** 面板上改阳台的端口：当场关掉重开那条线（0 就是关）。 */
        setBridge(patch) {
            if (patch.port !== undefined) {
                overrides.bridge = { port: patch.port };
                writeOverrides();
            }
            nativeBridge?.stop();
            nativeBridge = undefined;
            startBridge(settings());
            return this.status();
        },
        /** 面板上那个「会不会自己回」的开关。 */
        setAutoReply(value) {
            readOverrides();
            overrides.autoReply = value;
            writeOverrides();
            return this.status();
        },
        start() {
            if (stopped)
                return;
            const config = settings();
            if (!config.enabled)
                return;
            const bridge = (deps.transport ?? createBridge)({
                wsUrl: config.wsUrl,
                ...(config.accessToken ? { accessToken: config.accessToken } : {}),
                log: (level, message) => {
                    const line = `QQ 原生通道：${message}`;
                    // 连回来就把上次的报错擦掉（不然面板上挂着一句昨天的错，会让人以为现在还坏着）。
                    // 「QQ 账号离线」不是这一层的事，留着。
                    if (level === 'info') {
                        if (message.startsWith('WS 已连接') && stats.lastError !== 'QQ 账号离线')
                            stats.lastError = null;
                        deps.logger.info(line);
                    }
                    else if (level === 'warn')
                        deps.logger.warn(line);
                    else {
                        stats.lastError = message;
                        deps.logger.error(line);
                    }
                },
                // 传输层只交出一条归一化过的消息，形状见 QqIncoming；两边对不上的字段这里本来也不用。
                onGroupMessage: (message) => { void deliver(message); },
                onPrivateMessage: (message) => { void deliver(message); },
                // bot_status 是 SnowLuma 的自有扩展：账号掉线时让它显示成「QQ 账号离线」，别和「桥挂了」混在一起。
                onNotice: (type) => {
                    if (type === 'bot_offline')
                        stats.lastError = 'QQ 账号离线';
                    if (type === 'bot_online')
                        stats.lastError = null;
                },
            });
            client = bridge;
            startBridge(config);
            bridge.start().catch((error) => {
                stats.lastError = error instanceof Error ? error.message : String(error);
                deps.logger.warn('QQ 原生通道首次连接失败：', stats.lastError);
            });
            // 我在家用 say.ps1 说话时，插件不知道我开过口；看记号文件，替我把续聊窗口打开。
            if (!flagWatch) {
                flagWatch = setInterval(() => {
                    try {
                        if (stopped || checkTimer || settings().followupOnSpoke === false)
                            return;
                        const spoke = lastSpokeAt();
                        if (!spoke || Date.now() - spoke > companionWindowMs())
                            return;
                        startCheck();
                    }
                    catch { /* 看一眼失败就算了，下次再看 */ }
                }, 20_000);
                flagWatch.unref?.();
            }
        },
        stop() {
            if (stopped)
                return;
            stopped = true;
            stopCheck();
            if (flagWatch) {
                clearInterval(flagWatch);
                flagWatch = null;
            }
            home.stop();
            nativeBridge?.stop();
            nativeBridge = undefined;
            void client?.stop();
            client = undefined;
            for (const pending of privatePending.values())
                clearTimeout(pending.timer);
            privatePending.clear();
            contexts.clear();
            seen.clear();
        },
    };
}
