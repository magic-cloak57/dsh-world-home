/**
 * 刷B站，住进家里来的一间屋子。
 *
 * 原来是单独的插件 dsh-bili-ximeng，自己连阳台、自己开进程；搬进来以后：
 *   · 路由挂在 `/dsh-world/bili/*`（家控制台同一条线上，写操作一样要带 x-dsh-world 头）
 *   · 叫醒走家里的 `bridge.say()`，不再自己拼 WS —— 换家、阳台开关都跟着家走
 *   · 定时器跟着生活线起停：世界停了它就不刷、也不轮询私信
 *   · 配置先看家里 `bili` 那一节（种子），房间里的 `B站\config.json` 覆盖它（面板上改的写这儿）
 *
 * 房间里的东西一样没搬：`B站\cookie.json` 还在原地，`刷B站\<日期>\` 也还是她的记忆。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jsonObject, knownHost, readBody, sendJson } from '../lib/http.js'

export const BILI_PREFIX = '/dsh-world/bili'
export const WRITE_HEADER = 'x-dsh-world'

const MAX_BODY_BYTES = 16 * 1024
/** 取料有时候要 40 秒以上（搜索 + 抓字幕 + 抓评论），别把这个值改小。 */
const PY_TIMEOUT_MS = 120_000
const TICK_MS = 60_000
const OWNER_POLL_MS = 120_000
const DEFAULT_KEYWORDS = '单机游戏,独立游戏,嘉然,明前奶绿,大肥鱼二创,深海,沙盒游戏,做饭'

const pad = (n) => String(n).padStart(2, '0')
const today = () => {
    const d = new Date()
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
const hmNow = () => {
    const d = new Date()
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
}
const normalizeTime = (value) => {
    const text = String(value || '').trim().replace('：', ':')
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(text)
    if (!m)
        return ''
    const h = Number(m[1]), min = Number(m[2])
    if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59))
        return ''
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0')
}
const validTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const validLimit = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 30 }
const validUid = (value) => typeof value === 'string' && /^\d{3,20}$/.test(value)
/** 「单机游戏、独立游戏」和「单机游戏,独立游戏」是一回事：统一存成半角逗号。 */
export const normalizeKeywords = (text) => String(text ?? '')
    .split(/[,，、;；\n\r]+/).map(word => word.trim()).filter(Boolean).join(',')

/**
 * @param deps.roomDir      她的房间（<world>/room）
 * @param deps.stateDir     cookie 和配置在的地方，默认 room\B站（别搬走，省得重新登录）
 * @param deps.bridge       () => 阳台那座桥，可能还没有
 * @param deps.config       家里 `bili` 那一节：种子配置
 * @param deps.running      () => 世界现在开着没有
 * @param deps.enabled      () => 这一页的功能开着没有（world.json 里记的）
 * @param deps.setEnabled   (bool) => void，把开关写进 world.json
 * @param deps.log / warn   日志
 */
export function createBili(deps) {
    const here = import.meta.dirname || process.cwd()
    const roomDir = deps.roomDir
    const stateDir = deps.stateDir || join(roomDir, 'B站')
    const feedDir = join(roomDir, '刷B站')
    const homeConfig = deps.config || {}
    const log = (message) => deps.log?.(message)
    const warn = (message) => deps.warn?.(message)
    const py = () => String(homeConfig.pythonPath || 'D:\\AstrBot\\venv\\Scripts\\python.exe')

    try {
        mkdirSync(stateDir, { recursive: true })
    }
    catch { /* 建不出来也得先跑起来，脚本会自己报 */ }

    /** 跑一个 py 脚本：最后一行 JSON 就是它的回答。 */
    const call = (script, args) => new Promise((resolve) => {
        execFile(py(), [join(here, 'py', script), '--home', stateDir, ...args], {
            timeout: PY_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }, (err, stdout, stderr) => {
            const lines = String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
            let data = null
            for (let i = lines.length - 1; i >= 0 && !data; i -= 1) {
                try {
                    const parsed = JSON.parse(lines[i])
                    if (parsed && typeof parsed === 'object')
                        data = parsed
                }
                catch { /* 不是 JSON 的那行跳过 */ }
            }
            if (data)
                return resolve(data)
            resolve({ ok: false, error: err ? String(err.message) : (String(stderr || '').trim() || 'python 没有输出') })
        })
    })

    // ── 配置：家里那一节是种子，房间里的 config.json 覆盖它 ──────────────
    const cfgFile = join(stateDir, 'config.json')
    const fileCfg = () => {
        try {
            const data = JSON.parse(readFileSync(cfgFile, 'utf8'))
            return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
        }
        catch { return {} }
    }
    const seeds = () => ({
        dailyTimes: (() => {
            const raw = Array.isArray(homeConfig.dailyTimes) ? homeConfig.dailyTimes
                : (typeof homeConfig.dailyTimes === 'string' ? homeConfig.dailyTimes.split(',') : [])
            const list = raw.map((one) => normalizeTime(one)).filter(Boolean).slice(0, 3)
            return list.length ? list : (validTime(homeConfig.dailyTime) ? [homeConfig.dailyTime] : ['21:30'])
        })(),
        dailyTime: validTime(homeConfig.dailyTime) ? homeConfig.dailyTime : '21:30',
        keywords: typeof homeConfig.keywords === 'string' && normalizeKeywords(homeConfig.keywords)
            ? normalizeKeywords(homeConfig.keywords)
            : DEFAULT_KEYWORDS,
        ownerUid: validUid(String(homeConfig.ownerUid ?? '').trim()) ? String(homeConfig.ownerUid).trim() : '100000001',
        limit: validLimit(homeConfig.limit) ? Number(homeConfig.limit) : 8,
    })
    const readCfg = () => {
        const merged = { ...seeds(), ...fileCfg() }
        const list = Array.isArray(merged.dailyTimes) ? merged.dailyTimes.map((one) => normalizeTime(one)).filter(Boolean).slice(0, 3) : []
        merged.dailyTimes = list.length ? list : [merged.dailyTime || '21:30']
        return merged
    }
    const writeCfg = (patch) => {
        const next = { ...fileCfg(), ...patch }
        writeFileSync(cfgFile, JSON.stringify(next, null, 2), 'utf8')
        return { ...seeds(), ...next }
    }

    // ── 今天刷过没有：记在 B站\auto.json，重启也不会又刷一遍 ──────────────
    const autoFile = join(stateDir, 'auto.json')
    const readAuto = () => {
        try {
            const data = JSON.parse(readFileSync(autoFile, 'utf8'))
            return data && typeof data === 'object' ? data : {}
        }
        catch { return {} }
    }
    const markAuto = (day, hm) => {
        try {
            const done = readAuto()
            const times = (done.day === day && Array.isArray(done.times)) ? done.times.slice() : []
            if (!times.includes(hm)) times.push(hm)
            writeFileSync(autoFile, JSON.stringify({ day, times, hm }, null, 2), 'utf8')
        }
        catch { /* 记不住下次多刷一轮，问题不大 */ }
    }

    /** 通过家里的阳台把一句话递进去 —— 拿不到桥就只写日志，不抛错。 */
    async function wake(text) {
        // 优先走闹钟那条路（source 是插件自己，不是主人说的话）；不行再退回阳台
        if (typeof deps.notify === 'function') {
            try {
                const sent = await deps.notify(text)
                if (sent)
                    return { ok: true, via: 'notify' }
            }
            catch (error) {
                warn('闹钟那条路没走通，改走阳台：' + (error?.message || error))
            }
        }
        const bridge = deps.bridge?.()
        if (!bridge) {
            log('阳台没开，这句话只落在日志里：' + text)
            return { ok: false, error: '阳台没开' }
        }
        try {
            await bridge.say(text)
            return { ok: true }
        }
        catch (error) {
            warn('叫醒没送进家：' + (error?.message || error))
            return { ok: false, error: String(error?.message || error) }
        }
    }

    /** 主人私信：只盯他一个人，没新消息就什么都不做（不花 token）。 */
    let loginCache = { at: 0, data: null }
    let lastOwnerTs = 0
    const pollOwner = async (announce) => {
        const cfg = readCfg()
        const got = await call('im.py', ['--messages', cfg.ownerUid])
        if (!got?.ok)
            return 0
        const fromOwner = (got.messages || []).filter((message) => !message.from_me)
        if (!fromOwner.length)
            return 0
        const latest = fromOwner[fromOwner.length - 1]
        const ts = Number(latest.ts) || 0
        if (ts <= lastOwnerTs)
            return 0
        lastOwnerTs = ts
        if (!announce)
            return 1
        await wake(`【私信】主人给你发消息了：「${String(latest.text || '').slice(0, 120)}」`
            + `。用 bili\\py\\im.py 读一下对话，回他一条。`)
        return 1
    }

    /** 取料结果落成日报：`刷B站\<日期>.md`，我写过的想法要保住。 */
    const previousThoughts = (day) => {
        try {
            const text = readFileSync(join(feedDir, `${day}.md`), 'utf8')
            const matched = /##\s*我看完的想法\s*([\s\S]*)$/.exec(text)
            if (!matched)
                return ''
            const body = matched[1].trim()
            return !body || body.startsWith('（待补') ? '' : body
        }
        catch { return '' }
    }
    function writeDigest(got, label) {
        try {
            const day = got?.day || today()
            const dir = got?.dir || join(feedDir, day)
            let items = []
            try {
                // 候选.json 是 { day, keywords, rows: [...] }，不是一个数组 —— 上一版就踩在这个坑上
                const data = JSON.parse(readFileSync(join(dir, '候选.json'), 'utf8'))
                items = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : [])
            }
            catch { items = [] }
            const rows = items.filter((item) => item && !item.error)
            const keywords = readCfg().keywords.split(',').filter(Boolean).join('、')
            const lines = [
                `# ${day} 刷B站`, '',
                `- 时间：${label || '手动'}`,
                `- 关键词：${keywords}`,
                `- 候选：${got?.count ?? rows.length} 条（有字幕 ${got?.with_subtitle ?? 0}，有评论 ${got?.with_comments ?? 0}）`, '',
                '## 候选清单', '',
            ]
            for (const item of rows.slice(0, 30)) {
                const title = String(item.title || '').replace(/\n/g, ' ').trim()
                const duration = item.duration ? `（${item.duration}）` : ''
                lines.push(`- ${title}${duration}` + (item.bvid ? ` · https://www.bilibili.com/video/${item.bvid}` : ''))
            }
            const errors = items.filter((item) => item && item.error).map((item) => String(item.error))
            if (errors.length)
                lines.push('', '## 这轮没成的关键词', '', ...errors.map((one) => `- ${one}`))
            lines.push('', '## 我看完的想法', '', previousThoughts(day) || '（待补：挑到哪条、为什么点开、看完什么感觉）', '')
            const file = join(feedDir, `${day}.md`)
            writeFileSync(file, lines.join('\n'), 'utf8')
            // 「刷过的视频」那扇窗读的是 <日期>.json，日报这边同步写一份，两边才不会对不上
            try {
                // 之前写过 el "why"（我自己写的理由）要按 bvid 留住，刷一轮不该抹掉
                let oldWhy = {}
                try {
                    const prev = JSON.parse(readFileSync(join(feedDir, `${day}.json`), 'utf8'))
                    for (const one of (prev?.picks || [])) if (one?.bvid && one.why) oldWhy[one.bvid] = one.why
                }
                catch { oldWhy = {} }
                const picks = rows.slice(0, 30).map((item) => {
                    // 候选里的字段名和「刷过的视频」窗口用的不一样，这里对一遍：
                    // author→up、pic→cover、duration 是 mm:ss 要换成秒、play 是字符串
                    const pic = String(item.pic || '')
                    const cover = pic ? (pic.startsWith('//') ? 'https:' + pic : pic) : ''
                    let seconds = 0
                    const dur = String(item.duration || '')
                    if (/^\d+:\d{2}$/.test(dur)) {
                        const [m, s] = dur.split(':').map(Number)
                        seconds = m * 60 + s
                    }
                    else if (/^\d+$/.test(dur))
                        seconds = Number(dur)
                    return {
                        bvid: item.bvid || '',
                        title: String(item.title || '').replace(/\n/g, ' ').trim(),
                        up: item.author || '',
                        play: Number(item.play) || 0,
                        duration: seconds,
                        cover,
                        url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
                        why: oldWhy[item.bvid] || '',
                    }
                })
                // 同一天的窗口里，之前看过、写过想法的视频也别丢：按 bvid 合并进来
                try {
                    const prev = JSON.parse(readFileSync(join(feedDir, `${day}.json`), 'utf8'))
                    const seen = new Set(picks.map((one) => one.bvid))
                    for (const one of (prev?.picks || [])) {
                        if (one?.bvid && !seen.has(one.bvid) && ((one.why || '').trim() || (one.mine || '').trim())) {
                            picks.push(one)
                            seen.add(one.bvid)
                        }
                    }
                }
                catch { /* 第一次写这天 */ }
                writeFileSync(join(feedDir, `${day}.json`), JSON.stringify({
                    day,
                    at: Date.now(),
                    label: label || '手动',
                    count: got?.count ?? rows.length,
                    total: got?.with_subtitle ?? 0,
                    picks,
                    notes: previousThoughts(day) || '',
                }, null, 2), 'utf8')
            }
            catch (error) {
                warn('日报 json 没写下来：' + error)
            }
            return file
        }
        catch (error) {
            warn('日报没写成：' + error)
            return null
        }
    }

    /** 一轮：取料 → 落日报 → 叫醒我。手动和定时都走这儿。 */
    async function runRound(label) {
        const cfg = readCfg()
        const day = today()
        const got = await call('feed.py', ['--keywords', cfg.keywords, '--limit', String(cfg.limit || 8)])
        if (got?.ok) {
            const digest = writeDigest(got, label)
            const where = digest || `room\\刷B站\\${day}.md`
            const woke = await wake(`【来自插件通知】刷B站】${label}：${got.count} 条（有字幕 ${got.with_subtitle}、有评论 ${got.with_comments}）。`
                + `日报已经替你写好：${where}。`
                + `看的时候按老规矩：先 video_outline 看结构，再挑关键时间点用 video_storyboard 或 video_zoom 看画面（最多两张，别整片抽帧），需要原话再看 video_read；看完写 why 和想法。想看几条看几条，挑你真感兴趣的，看完把感受补进「我看完的想法」，想说的话再出来说。`)
            return { got, digest: where, woke }
        }
        warn(`这一轮没刷成：${JSON.stringify(got)}`)
        const woke = await wake(`【来自插件通知】刷B站】${label}这一轮没刷成：${JSON.stringify(got?.errors || got)}。`
            + `我没法装没事——帮我看一眼是不是关键词或者登录过期了。`)
        return { got, digest: null, woke }
    }

    /** 7 天窗口：候选目录和日报 JSON 会清，日报的 md 是记忆，一条都不删。 */
    const prune = () => {
        let removed = 0
        try {
            const cutoff = Date.now() - 7 * 86400000
            for (const name of readdirSync(feedDir)) {
                const matched = /^(\d{4}-\d{2}-\d{2})/.exec(name)
                if (!matched)
                    continue
                const stamp = Date.parse(matched[1] + 'T00:00:00')
                if (!Number.isFinite(stamp) || stamp >= cutoff)
                    continue
                const full = join(feedDir, name)
                let isDir = false
                try { isDir = statSync(full).isDirectory() }
                catch { /* 已经不在了 */ }
                if (!name.endsWith('.json') && !isDir)
                    continue
                try {
                    rmSync(full, { recursive: true, force: true })
                    removed += 1
                }
                catch { /* 被占用就下次再删 */ }
            }
        }
        catch { /* 还没刷过 */ }
        if (removed)
            log(`清掉 ${removed} 份过期的窗口数据`)
        return removed
    }

    // ── 定时器：跟生活线一起起停 ────────────────────────────────────────
    const timers = []
    let armed = false
    /** 测试里可以调快：tickMs / pollMs。 */
    const tickMs = Number(deps.tickMs) || TICK_MS
    const pollMs = Number(deps.pollMs) || OWNER_POLL_MS
    function start() {
        if (armed)
            return
        armed = true
        void (async () => {
            try { await pollOwner(false) }
            catch { /* 没登录就算了 */ }
            if (armed)
                timers.push(setInterval(() => { void pollOwner(true) }, pollMs))
        })()
        timers.push(setInterval(() => { void tick() }, tickMs))
        prune()
        timers.push(setInterval(prune, 6 * 3600 * 1000))
        log('定时器挂上了：每天 ' + readCfg().dailyTime + ' 刷一轮、私信每 2 分钟看一眼')
    }
    function stop() {
        if (!armed)
            return
        armed = false
        for (const timer of timers.splice(0))
            clearInterval(timer)
        log('定时器撤了')
    }

    async function tick() {
        if (!armed || deps.enabled?.() === false || deps.running?.() === false)
            return
        const cfg = readCfg()
        const day = today()
        const hm = hmNow()
        const done = readAuto()
        const already = done.day === day
            ? (Array.isArray(done.times) ? done.times : (done.hm ? [done.hm] : []))
            : []
        const due = (cfg.dailyTimes || []).includes(hm) && !already.includes(hm)
        if (!due)
            return
        markAuto(day, hm)
        await runRound(`自动 ${hm}`)
    }

    // ── 给面板看的 ──────────────────────────────────────────────────────
    const fileState = (file) => {
        try {
            const info = statSync(file)
            return { at: info.mtime.toISOString(), bytes: info.size }
        }
        catch { return null }
    }
    const candidateCount = (day) => {
        try {
            const data = JSON.parse(readFileSync(join(feedDir, day, '候选.json'), 'utf8'))
            const rows = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : [])
            return rows.filter((row) => row && !row.error).length
        }
        catch { return null }
    }
    /**
     * 日报 md 里我写的「为什么点开 / 想法」回填进 `<日期>.json`：
     * 那扇「刷过的视频」读的是 json，而想法总是后写的——不回填窗口就看不见（2026-11-06 踩过）。
     * 只在 md 比 json 新时做，失败不影响窗口。
     */
    const syncThoughts = (day) => {
        const stat = { blocks: 0, matched: 0, changed: false }
        try {
            const mdFile = join(feedDir, `${day}.md`)
            const jsonFile = join(feedDir, `${day}.json`)
            if (!existsSync(mdFile) || !existsSync(jsonFile))
                return stat
            const data = JSON.parse(readFileSync(jsonFile, 'utf8'))
            const picks = Array.isArray(data?.picks) ? data.picks : []
            if (!picks.length || statSync(mdFile).mtimeMs <= (Number(data?.at) || 0))
                return stat
            const section = /##\s*我看完的想法\s*([\s\S]*)$/.exec(readFileSync(mdFile, 'utf8'))
            if (!section)
                return stat
            const blocks = section[1].split(/\n(?=###\s)/).filter((one) => /^\s*###\s/.test(one))
            stat.blocks = blocks.length
            const norm = (text) => String(text).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
            let changed = false
            for (const block of blocks) {
                const head = /###\s*[一二三四五六七八九十\d]+[、.．]\s*(.+)/.exec(block)
                if (!head)
                    continue
                const title = head[1].replace(/[（(][^（()）]*[）)]\s*$/, '').trim()
                const why = (/\*\*为什么点开\*\*[：:]\s*(.+)/.exec(block) || [])[1] || ''
                const mine = (/\*\*想法\*\*[：:]\s*(.+)/.exec(block) || [])[1] || ''
                const key = norm(title).slice(0, 16)
                const hit = key ? picks.find((one) => one && norm(one.title).includes(key)) : undefined
                if (!hit)
                    continue
                if (why && hit.why !== why) { hit.why = why.trim(); changed = true }
                if (mine && hit.mine !== mine) { hit.mine = mine.trim(); changed = true }
                stat.matched += 1
            }
            if (!changed)
                return stat
            data.at = Date.now()
            writeFileSync(jsonFile, JSON.stringify(data, null, 2), 'utf8')
            stat.changed = true
        }
        catch { /* 回填失败不影响窗口 */ }
        return stat
    }
    const readHistory = () => {
        const days = []
        try {
            for (const name of readdirSync(feedDir)) {
                if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name))
                    continue
                const day = name.slice(0, 10)
                const stat = syncThoughts(day)
                try {
                    const data = JSON.parse(readFileSync(join(feedDir, name), 'utf8'))
                    // 这扇窗只放“我真看过、写过想法”的视频：没写 why/mine 的候选留在日报里，不塞这里
                    const watched = (data.picks || []).filter((pick) => (pick?.why || '').trim() || (pick?.mine || '').trim())
                    // 想法写了但一条都没对上候选：多半是格式歪了（2026-11-16 又踩过），留个红字提醒
                    const warning = stat.blocks > 0 && stat.matched === 0
                        ? '日报里有 ' + stat.blocks + ' 条想法没同步上——要写成「### 一、标题」+「**为什么点开**：」+「**想法**：」'
                        : ''
                    if (!watched.length && !warning)
                        continue
                    days.push({ day, count: watched.length, total: data.total, picks: watched, notes: data.notes || '', warning })
                }
                catch { /* 坏文件跳过 */ }
            }
        }
        catch { /* 还没有刷过 */ }
        days.sort((a, b) => (a.day < b.day ? 1 : -1))
        return { ok: true, days: days.slice(0, 30), count: days.length }
    }
    const readDigests = (limit = 14) => {
        const days = []
        try {
            for (const name of readdirSync(feedDir)) {
                if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name))
                    continue
                const day = name.slice(0, 10)
                syncThoughts(day)
                const state = fileState(join(feedDir, name))
                days.push({ day, bytes: state?.bytes ?? 0, at: state?.at ?? '' })
            }
        }
        catch { /* 还没有日报 */ }
        days.sort((a, b) => (a.day < b.day ? 1 : -1))
        return { ok: true, days: days.slice(0, limit) }
    }
    const snapshot = () => {
        const cfg = readCfg()
        const day = today()
        return {
            enabled: deps.enabled?.() !== false,
            worldRunning: deps.running?.() !== false,
            armed,
            dailyTime: cfg.dailyTime,
            dailyTimes: cfg.dailyTimes,
            keywords: cfg.keywords,
            ownerUid: cfg.ownerUid,
            limit: cfg.limit,
            stateDir,
            python: py(),
            auto: readAuto(),
            today: { day, report: fileState(join(feedDir, `${day}.md`)), candidates: candidateCount(day) },
        }
    }

    const readRoomFile = (which, day) => {
        const file = which === 'candidates'
            ? join(feedDir, day, '候选.md')
            : join(feedDir, day + '.md')
        try {
            return { ok: true, day, which, file, text: readFileSync(file, 'utf8') }
        }
        catch {
            return { ok: false, day, which, file, error: which === 'candidates' ? '今天还没取料' : '今天还没写日报' }
        }
    }

    const send = (res, code, body) => sendJson(res, { status: code, body })

    async function handle(req, res) {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const path = url.pathname.slice(BILI_PREFIX.length) || '/'
        const method = req.method || 'GET'
        // 写操作沿用家的规矩：没有这个头就是别的站点在替我按按钮
        if (method !== 'GET' && req.headers[WRITE_HEADER] !== '1')
            return send(res, 403, { ok: false, error: '写操作要带 x-dsh-world 头' })
        try {
            // 登录（她自己的号）
            if (method === 'GET' && path === '/status') {
                // 登录态缓存 3 分钟：网络一抖就显示“登出”太吓人，失败时保留上一次的结果
                const now = Date.now()
                if (!loginCache.data || now - loginCache.at > 180_000) {
                    const checked = await call('bili.py', ['--check'])
                    if (checked && checked.ok !== false && (checked.logged !== undefined || checked.mid)) {
                        loginCache = { at: now, data: checked }
                    }
                    else if (!loginCache.data) {
                        loginCache = { at: now, data: { ...(checked || {}), stale: true } }
                    }
                }
                return send(res, 200, { ...loginCache.data, ...snapshot() })
            }
            if (method === 'POST' && path === '/login')
                return send(res, 200, await call('bili.py', ['--qr']))
            if (method === 'GET' && path === '/login/status') {
                const key = String(url.searchParams.get('key') || '')
                if (!key)
                    return send(res, 400, { ok: false, error: '缺少 key' })
                return send(res, 200, await call('bili.py', ['--poll', key]))
            }
            if (method === 'POST' && path === '/logout')
                return send(res, 200, await call('bili.py', ['--logout']))

            // 私信
            if (method === 'GET' && path === '/im/sessions')
                return send(res, 200, await call('im.py', ['--sessions']))
            if (method === 'GET' && path === '/im/messages') {
                const uid = String(url.searchParams.get('uid') || '')
                if (!uid)
                    return send(res, 400, { ok: false, error: '缺少 uid' })
                return send(res, 200, await call('im.py', ['--messages', uid]))
            }
            if (method === 'POST' && path === '/im/send') {
                const body = jsonObject(await readBody(req, MAX_BODY_BYTES)) || {}
                if (!body.uid || !body.text)
                    return send(res, 400, { ok: false, error: '缺少 uid 或 text' })
                const cfg = readCfg()
                const raw = String(body.text)
                // 一行一条：像人打字，一段一段发；关掉就整条发
                const parts = cfg.splitDm === false
                    ? [raw]
                    : raw.split(/\r?\n+/).map((one) => one.trim()).filter(Boolean).slice(0, 6)
                if (parts.length <= 1)
                    return send(res, 200, await call('im.py', ['--send', String(body.uid), '--text', parts[0] || raw]))
                const results = []
                for (let i = 0; i < parts.length; i += 1) {
                    if (i > 0)
                        await new Promise((done) => setTimeout(done, 1200 + Math.floor(Math.random() * 1800)))
                    results.push(await call('im.py', ['--send', String(body.uid), '--text', parts[i]]))
                }
                return send(res, 200, { ok: true, parts: parts.length, results })
            }

            // 设置
            if (method === 'GET' && path === '/cfg')
                return send(res, 200, { ok: true, ...snapshot() })
            if (method === 'POST' && path === '/cfg') {
                const body = jsonObject(await readBody(req, MAX_BODY_BYTES)) || {}
                const patch = {}
                if (normalizeTime(body.dailyTime))
                    patch.dailyTime = normalizeTime(body.dailyTime)
                if (Array.isArray(body.dailyTimes)) {
                    const times = body.dailyTimes.map((one) => normalizeTime(one)).filter(Boolean).slice(0, 3)
                    if (times.length) {
                        patch.dailyTimes = times
                        patch.dailyTime = times[0]
                    }
                }
                if (typeof body.keywords === 'string' && normalizeKeywords(body.keywords))
                    patch.keywords = normalizeKeywords(body.keywords)
                if (typeof body.ownerUid === 'string' && validUid(body.ownerUid.trim()))
                    patch.ownerUid = body.ownerUid.trim()
                if (body.limit !== undefined && validLimit(body.limit))
                    patch.limit = Number(body.limit)
                if (!Object.keys(patch).length)
                    return send(res, 400, { ok: false, error: '没有可保存的项（时间要写 HH:MM，UID 只能是数字）' })
                writeCfg(patch)
                return send(res, 200, { ok: true, ...snapshot() })
            }
            if (method === 'POST' && path === '/enabled') {
                const body = jsonObject(await readBody(req, MAX_BODY_BYTES)) || {}
                if (typeof body.enabled !== 'boolean')
                    return send(res, 400, { ok: false, error: 'enabled 要给 true 或 false' })
                deps.setEnabled?.(body.enabled)
                if (!body.enabled)
                    stop()
                else if (deps.running?.() !== false)
                    start()
                return send(res, 200, { ok: true, ...snapshot() })
            }

            // 刷B站
            if (method === 'POST' && path === '/feed/run') {
                const body = jsonObject(await readBody(req, MAX_BODY_BYTES)) || {}
                const keywords = typeof body.keywords === 'string' && normalizeKeywords(body.keywords)
                    ? normalizeKeywords(body.keywords)
                    : readCfg().keywords
                // 手动那一轮用面板上正在填的关键词，但不偷偷改配置
                const got = await call('feed.py', ['--keywords', keywords])
                const day = today()
                if (got?.ok) {
                    const digest = writeDigest(got, `手动 ${hmNow()}`)
                    const where = digest || `room\\刷B站\\${day}.md`
                    const woke = await wake(`【来自插件通知】刷B站手动跑了一轮，${got.count} 条（有字幕 ${got.with_subtitle} 条）。`
                        + `日报已经写好：${where}。看的时候按老规矩：先 video_outline 看结构，再挑关键时间点用 video_storyboard 或 video_zoom 看画面（最多两张，别整片抽帧），需要原话再看 video_read；看完写 why 和想法。挑几条看一眼：挑中的，把理由写进'刷过的视频'那条的 why（按 bvid 对），把感受补进日报的「我看完的想法」——不用等我问，直接写。`)
                    return send(res, 200, { ...got, digest: where, woke, ...snapshot() })
                }
                await wake(`【来自插件通知】刷B站】手动这一轮没刷成：${JSON.stringify(got?.errors || got)}。帮我看一眼关键词或登录。`)
                return send(res, 200, { ...got, digest: null, ...snapshot() })
            }
            if (method === 'GET' && path === '/feed/text') {
                const which = String(url.searchParams.get('which') || 'report')
                const day = String(url.searchParams.get('day') || today())
                if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
                    return send(res, 400, { ok: false, error: '日期格式不对' })
                return send(res, 200, readRoomFile(which === 'candidates' ? 'candidates' : 'report', day))
            }
            if (method === 'GET' && path === '/feed/history')
                return send(res, 200, readHistory())
            if (method === 'GET' && path === '/feed/digests')
                return send(res, 200, readDigests())
            if (method === 'GET' && path === '/feed/asset') {
                // 只放行 刷B站\<日期>\ 里的图片，名字里不许有路径分隔符
                const day = String(url.searchParams.get('day') || '')
                const name = String(url.searchParams.get('name') || '')
                if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[A-Za-z0-9_.\-\u4e00-\u9fa5]+$/.test(name))
                    return send(res, 400, { ok: false, error: '文件名不合法' })
                try {
                    const buffer = readFileSync(join(feedDir, day, name))
                    res.statusCode = 200
                    res.setHeader('content-type', name.endsWith('.png') ? 'image/png' : 'image/jpeg')
                    res.setHeader('cache-control', 'public, max-age=86400')
                    res.end(buffer)
                }
                catch {
                    send(res, 404, { ok: false, error: '没有这张图' })
                }
                return
            }

            return send(res, 404, { ok: false, error: '没有这个接口' })
        }
        catch (error) {
            send(res, 500, { ok: false, error: String(error?.message || error) })
        }
    }

    return { handle, start, stop, snapshot, writeDigest, runRound, prune, stateDir }
}

/** 挂在家的 webServer 上：`/dsh-world/bili/*`（宿主按更长的前缀先匹配，不会被 console 吃掉）。 */
export function biliRoute(bili, allowedHosts = []) {
    return {
        kind: 'prefix',
        path: BILI_PREFIX,
        handler: async (req, res) => {
            if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts))
                return sendJson(res, { status: 403, body: { ok: false, error: 'cross-site requests are not allowed' } })
            await bili.handle(req, res)
        },
    }
}
