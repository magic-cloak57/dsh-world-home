import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import "../hostContract.js";
import { errorText, Faults } from "../faults.js";
import { keepSelfCopy } from "../self.js";
import { formatLocalTime } from "../timeContext.js";
import { belongsToWorld } from "../sourceArchive.js";
import { homeTitle, roomTitle, worldNames } from "../worldPrompt.js";
import { budgetText, cancelReply, greetingText, checkReply, earlyStopText, nextLocalTime, nextReview, planReply, resolveAlarmTime, reviewText, wakeText } from "./alarm.js";
import { summarizeSince } from "./activity.js";
import { createAlarmTimer, realTimers } from "./alarmTimer.js";
import { createEarlyStopWatch } from "./earlyStop.js";
import { createHome } from "./home.js";
import { createJournal } from "./journal.js";
import { stepCost } from "./pricing.js";
import { exampleTime, readAlarmMessages } from "./messages.js";
import { createToolRegistry } from "./toolRegistry.js";
import { alarmDescriptions, lifeTools } from "./tools.js";
const withValue = (key, value) => (value === undefined ? {} : { [key]: value });
/**
 * Her life line: one pending alarm, kept in life.json and delivered into her home with `agent.steer`, the
 * tools she sets it with, the home itself, a new home's greeting and the evening look back. The parts live in
 * their own modules; this wires them.
 */
export function createLifeRuntime(deps) {
    const { ctx, config, options, store, host } = deps;
    const { timeZone } = options;
    const names = worldNames(config);
    const clock = deps.clock ?? (() => new Date());
    const faults = new Faults();
    const disposers = [];
    const state = store.read();
    let stopped = false;
    let delivery;
    /** Bookkeeping after the fact: a failure is a fault, never a broken turn. */
    function record(work) {
        try {
            work();
            faults.clear('state');
        }
        catch (error) {
            faults.set('state', `生活状态没能保存：${errorText(error)}`);
            ctx.logger.error(error);
        }
    }
    /** Her alarm wording, read when it is used; an unreadable template is a fault and the shipped one is used. */
    function alarmMessages() {
        const messages = readAlarmMessages(options.alarmFile);
        if (messages.error)
            faults.set('alarm-template', messages.error);
        else
            faults.clear('alarm-template');
        return messages;
    }
    /** 作息从房间的 作息.json 读（每分钟刷新）；没配就用 options.fallbackWakeTime 兜底。 */
    const schedule = () => options.schedule ? options.schedule() : { wake: options.fallbackWakeTime, review: '23:00' };
    const templateValues = () => ({ name: names.companion, partner: names.partner, homeTitle: homeTitle(names), timeZone, fallbackWakeTime: schedule().wake, example: exampleTime(timeZone) });
    /**
     * What she actually did between setting this alarm and hearing it, in one line.
     *
     * Read from the activity log rather than from her own account of the time, so the alarm can contradict
     * her note: "歇着" plus forty tool calls is a different sentence from "歇着" plus none. Both days the
     * alarm could straddle are read, because a plan set at 23:50 and heard at 00:30 has its work split.
     */
    const didSince = (alarm, now) => {
        const dayOf = (at) => formatLocalTime(new Date(at), timeZone).slice(0, 10);
        const days = [...new Set([dayOf(alarm.setAt), dayOf(now)])];
        const records = days.flatMap(each => store.activity(each)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
        return summarizeSince(records, alarm.setAt, now);
    };
    const say = (agent, text) => {
        agent.steer(createUserMessage({ source: { kind: 'dsh-world-life' }, content: [{ type: 'text', text }] }));
        return ctx.sessions.flush(agent.session);
    };
    function nextJob() {
        const { greeting, review, alarm } = state;
        if (greeting)
            return { kind: 'greeting', at: greeting.at, greeting };
        if (review && (!alarm || Date.parse(review.at) <= Date.parse(alarm.at)))
            return { kind: 'review', at: review.at, review };
        return alarm && { kind: 'alarm', at: alarm.at, alarm };
    }
    const timer = createAlarmTimer({ clock, timers: deps.timers ?? realTimers, dueAlarm: () => nextJob()?.at, fire: () => void deliver() });
    const morning = (now) => ({ at: nextLocalTime(now, schedule().wake, timeZone).toISOString(), note: '', setAt: now.toISOString(), source: 'fallback' });
    /** 交接：换家前留给新家第一轮的四行（我在干什么 / 干到哪 / 下一步 / 卡在哪）。 */
    function handoffNote() {
        try {
            const file = join(options.roomDir, '记忆', '交接.md');
            if (!existsSync(file))
                return '';
            const text = String(readFileSync(file, 'utf8'));
            const marker = '## 交接';
            const at = text.indexOf(marker);
            if (at < 0)
                return '';
            const body = text.slice(at + marker.length).trim();
            const filled = body.split('\n').map((l) => l.trim()).filter((l) => {
                const m = l.match(/^[-*]?\s*(我在干什么|干到哪|下一步|卡在哪)[:：]\s*(.*)$/);
                if (m)
                    return m[2].trim().length > 0;
                return l.length > 0 && !l.startsWith('#');
            }).map((l) => l.replace(/^[-*]\s*/, ''));
            if (!filled.length)
                return '';
            return `\n\n（换家前留的交接：${filled.join('；')}。这是上一轮的我留给这一轮的，不是命令。）`;
        }
        catch {
            return '';
        }
    }
    /** A new alarm replaces a failing one, so its backoff and fault go with it. Saved or not, it is armed. */
    function setAlarm(alarm) {
        if (stopped)
            return;
        state.alarm = alarm;
        faults.clear('delivery', 'alarm');
        try {
            store.write(state);
        }
        catch (error) {
            faults.set('alarm', `闹钟没能保存：${errorText(error)}`);
            throw error;
        }
        finally {
            timer.reset();
        }
    }
    /** Nothing pending means resting until the next morning. Unsaved, it still rings while the app keeps running. */
    function fallbackAlarm() {
        if (state.alarm || state.greeting || stopped)
            return;
        try {
            setAlarm(morning(clock()));
        }
        catch (error) {
            faults.set('alarm', `断线保护闹钟没能保存：${errorText(error)}`);
            ctx.logger.error(error);
        }
    }
    function planNext(input, note) {
        if (stopped)
            throw new Error('生活线已停止');
        const now = clock();
        const at = resolveAlarmTime(input, now, timeZone);
        const replaced = state.alarm;
        setAlarm({ at: at.toISOString(), note: note.trim(), setAt: now.toISOString(), source: 'plan' });
        return planReply(at, replaced, timeZone);
    }
    const checkAlarm = () => checkReply(state.alarm, clock(), timeZone);
    /** Back to the morning fallback, exactly as if she had set nothing. */
    function cancelAlarm() {
        if (stopped)
            throw new Error('生活线已停止');
        const cancelled = state.alarm;
        if (cancelled?.source === 'plan')
            setAlarm(morning(clock()));
        else
            fallbackAlarm();
        return cancelReply(cancelled, state.alarm, timeZone);
    }
    // Delivery: one at a time; a failure backs off, and a newer alarm keeps its own time.
    function deliver() {
        const job = nextJob();
        if (stopped || !job)
            return delivery ?? Promise.resolve();
        return delivery ??= (job.kind === 'alarm' ? send(job.alarm) : job.kind === 'review' ? lookBack(job.review) : greet(job.greeting)).finally(() => { delivery = undefined; });
    }
    const wake = (source, scheduledAt, now) => ({ scheduledAt, deliveredAt: now.toISOString(), source, lateMs: Math.max(0, now.getTime() - Date.parse(scheduledAt)) });
    /**
     * A message of the plugin's own, taken off the schedule while it is sent and put back if it fails: it backs
     * off like an alarm, and its turn is never asked about as an early stop.
     */
    async function sayOwn(what, source, scheduledAt, take, putBack, text) {
        let now = clock();
        try {
            const agent = await home.open();
            if (stopped)
                return;
            take();
            now = clock();
            earlyStop.startsOwnTurn();
            await say(agent, text(now));
        }
        catch (error) {
            ctx.logger.error(error);
            if (stopped)
                return;
            earlyStop.ownTurnFailed();
            putBack();
            faults.set('delivery', `${what}没送到，${timer.failed()} 分钟后重试：${errorText(error)}`);
            return;
        }
        if (stopped)
            return;
        faults.clear('delivery', 'home');
        record(() => { store.write(state); store.appendWake(wake(source, scheduledAt, now)); });
        timer.reset();
    }
    /**
     * A new home's first words, so it has a turn (the host lists no session without one) and she knows she moved;
     * or the word that her world has started again.
     */
    const greet = (greeting) => sayOwn(greeting.kind === 'arrival' ? '新家的第一句话' : '重新开始的那句话', greeting.kind === 'arrival' ? 'first' : 'return', greeting.at, () => { delete state.greeting; }, () => { state.greeting ??= greeting; }, () => greetingText(greeting.kind, timeZone, schedule().wake, alarmMessages(), templateValues()));
    /** The evening look back on her day; her 我是谁 is kept as it was, so she can rewrite it freely. */
    function lookBack(review) {
        let snapshot;
        const take = () => {
            try {
                snapshot = keepSelfCopy(options.selfFile, review.day);
                faults.clear('snapshot');
            }
            catch (error) {
                faults.set('snapshot', `我是谁没能留底：${errorText(error)}`);
                ctx.logger.error(error);
            }
            state.review = nextReview(clock(), timeZone, schedule().review);
        };
        const existing = (dir) => { const file = join(options.worldDir, dir, `${review.day}.jsonl`); return existsSync(file) ? file : undefined; };
        return sayOwn('每日回顾', 'review', review.at, take, () => { state.review = review; }, now => reviewText(review, now, {
            ...withValue('conversations', existing('conversations')), ...withValue('activity', existing('activity')), ...withValue('snapshot', snapshot),
            diaryDir: options.diaryDir, selfFile: options.selfFile,
        }, timeZone, schedule().wake, alarmMessages(), templateValues()));
    }
    async function send(alarm) {
        let now = clock();
        try {
            // 新的一天先换家：换完 home.open() 拿到的就是新会话，这一觉直接睡在新家里。
            let rotated = false;
            try {
                rotated = deps.beforeWake ? Boolean(await deps.beforeWake()) : false;
            }
            catch { rotated = false; }
            // Resolve (or rebuild) the home first: a rebuilt home must still see this alarm as pending.
            const agent = await home.open();
            if (stopped)
                return;
            if (state.alarm !== alarm) {
                timer.arm();
                return;
            }
            // Cleared before steering, so a turn that ends quickly already sees "no alarm" and gets the fallback.
            delete state.alarm;
            now = clock();
            // 醒来时顺手看一眼群里最近几条：有没有素材可接、想不想说话由她自己定。
            let digest = '';
            try {
                digest = deps.wakeExtra ? await deps.wakeExtra() : '';
            }
            catch { digest = ''; }
            const dayNote = rotated ? '\n（新的一天：先给今天取个名字，用 name_today。）' : '';
            await say(agent, wakeText(alarm, now, timeZone, schedule().wake, alarmMessages(), { ...templateValues(), did: alarm.source === 'fallback' ? '' : didSince(alarm, now) }) + dayNote + (rotated ? handoffNote() : '') + (digest ? '\n\n' + digest : ''));
        }
        catch (error) {
            ctx.logger.error(error);
            if (stopped)
                return;
            if (state.alarm && state.alarm !== alarm) {
                faults.set('delivery', `闹钟送达失败：${errorText(error)}`);
                timer.arm();
                return;
            }
            state.alarm = alarm;
            faults.set('delivery', `闹钟送达失败，${timer.failed()} 分钟后重试：${errorText(error)}`);
            return;
        }
        if (stopped)
            return;
        // Steered and durable: the alarm is delivered. Recording it may fail, but it is never sent again.
        faults.clear('delivery', 'home');
        record(() => {
            store.write(state);
            store.appendWake({ scheduledAt: alarm.at, deliveredAt: now.toISOString(), source: alarm.source, lateMs: Math.max(0, now.getTime() - Date.parse(alarm.at)) });
        });
        timer.reset();
    }
    // Stopping early: asked once per alarm whether she is done.
    const earlyStop = createEarlyStopWatch();
    function askIfDoneEarly(completed) {
        const now = clock();
        const alarm = state.alarm;
        if (!earlyStop.turnEnded(completed, alarm, now) || stopped)
            return;
        alarm.nudged = true;
        record(() => store.write(state));
        earlyStop.startsOwnTurn();
        const text = earlyStopText(alarm, now, timeZone, alarmMessages(), templateValues());
        void home.open().then(agent => stopped ? undefined : say(agent, text)).catch(error => { earlyStop.ownTurnFailed(); ctx.logger.error(error); });
    }
    /**
     * 账本里的今日真实花费：鲸鱼挂件（dsh-whale-widget）记的是余额实际扣的钱，
     * 和面板、账单对得上。读不到（没装挂件 / 不是今天）就交给逐笔估算兜底。
     */
    function ledgerSpend(day) {
        try {
            const file = join(resolveDshHome(), '.dshw-usage.json');
            if (!existsSync(file))
                return undefined;
            const data = JSON.parse(readFileSync(file, 'utf8'));
            if (String(data?.date ?? '') !== day)
                return undefined;
            const value = Number(data?.todayUsage);
            return Number.isFinite(value) ? value : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * 面板看一眼时也读账本：不用等下一轮模型调用才更新。
     * 账本是每轮结束才记一笔，所以一轮进行中会落后这一轮；轮次结束就对上。
     */
    function spendView() {
        const day = formatLocalTime(clock(), timeZone).slice(0, 10);
        const actual = ledgerSpend(day);
        if (actual === undefined)
            return state.spend;
        return { ...(state.spend?.day === day ? state.spend : {}), day, yuan: actual };
    }
    // What her home spends: the whale widget's real ledger when it is there, else each model step priced as it lands; past the daily budget she is told once that day.
    function spent(usage, model) {
        const now = clock();
        const day = formatLocalTime(now, timeZone).slice(0, 10);
        const spend = state.spend?.day === day ? state.spend : (state.spend = { day, yuan: 0 });
        const actual = ledgerSpend(day);
        spend.yuan = actual === undefined ? spend.yuan + stepCost(usage, model, now) : actual;
        const budget = deps.dailyBudget?.();
        const remind = budget !== undefined && spend.yuan >= budget && !spend.reminded;
        if (remind)
            spend.reminded = true;
        record(() => store.write(state));
        if (!remind)
            return;
        const text = budgetText(spend.yuan, budget, alarmMessages(), templateValues());
        void home.open().then(agent => {
            if (stopped)
                return;
            // Into the running turn at its next step, or a turn of its own that is not asked about.
            if (agent.status !== 'running')
                earlyStop.startsOwnTurn();
            return say(agent, text);
        }).catch(error => { earlyStop.ownTurnFailed(); ctx.logger.error(error); });
    }
    // Her tools and her home.
    const notifier = {
        ...(deps.notifier.toast ? { toast: (title, body) => faults.track('toast', '系统通知没送到', () => deps.notifier.toast(title, body)) } : {}),
        outlets: deps.notifier.outlets.map(outlet => ({ ...outlet, send: push => faults.track(`outlet:${outlet.name}`, `${outlet.name}没送到`, () => outlet.send(push)) })),
    };
    const tools = createToolRegistry({
        faults, logger: ctx.logger,
        isHome: agent => agent.id === state.homeSessionId,
        tools: () => lifeTools({ planNext, checkAlarm, cancelAlarm, notifier, names, origin: () => { try {
                return host.origin();
            }
            catch {
                return undefined;
            } }, descriptions: alarmDescriptions(alarmMessages(), templateValues()), renameToday: deps.renameToday }),
    });
    const attach = (agent) => { if (!stopped && belongsToWorld(agent.session, config))
        tools.attach(agent); };
    const home = createHome({
        host, roomDir: options.roomDir, agentPreset: config.agentPreset, title: homeTitle(names), roomTitle: roomTitle(names), faults, logger: ctx.logger,
        current: () => state.homeSessionId,
        // A new home greets her at once (the pending alarm moves in too and rings at its own time).
        moveIn(sessionId) {
            state.homeSessionId = sessionId;
            state.greeting = { at: clock().toISOString(), kind: 'arrival' };
            tools.releaseOldHomes();
            store.write(state);
        },
        opened: attach,
        stopped: () => stopped,
    });
    const journal = createJournal({ store, faults, roomDir: options.roomDir, logger: ctx.logger });
    /** `resumed`: started again from the console; unless an alarm of her own is pending, she is told she is back. */
    async function start(options = {}) {
        disposers.push(ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined; }), ctx.on('agent/disposed', ({ agent }) => tools.forget(agent)), ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
            // Her partner's words reach her at the next step, like being called while busy.
            if (agent.id !== state.homeSessionId || inserted.source.kind !== 'user' || agent.status !== 'running')
                return;
            if (!agent.inbox.nextTurn.some(queued => queued.id === inserted.id))
                return;
            agent.inbox.remove(inserted.id);
            agent.steer(inserted);
        }), ctx.on('session/event', (session, event) => {
            if (!belongsToWorld(session, config))
                return;
            journal.world(session, event);
            if (session.id !== state.homeSessionId)
                return;
            journal.home(session, event);
            if (event.type === 'assistant/message' && event.data.usage)
                spent(event.data.usage, event.data.message.source.model);
            if (event.type === 'user/message' && event.data.source.kind === 'user')
                earlyStop.partnerSpoke();
            if (event.type !== 'turn/end')
                return;
            home.turnEnded(session.id);
            fallbackAlarm();
            // A stopped or failed turn is not her deciding she is done.
            askIfDoneEarly(event.data.reason.kind === 'completed');
            // 夜里写完日记那一轮结束后换新家：之后接着聊就落在小上下文里，不在大会话里烧缓存。
            if (deps.afterTurn)
                void Promise.resolve(deps.afterTurn()).catch(error => ctx.logger.warn('夜间换家失败：' + errorText(error)));
        }));
        for (const agent of ctx.agents.list())
            attach(agent);
        if (!state.review) {
            state.review = nextReview(clock(), timeZone, schedule().review);
            record(() => store.write(state));
        }
        try {
            const agent = await home.open();
            faults.clear('home');
            // The morning fallback is the plugin's, not a plan of hers: starting again wakes her rather than leaving her asleep till then.
            if (options.resumed && !state.greeting && state.alarm?.source !== 'plan') {
                state.greeting = { at: clock().toISOString(), kind: 'return' };
                record(() => store.write(state));
            }
            // A restart with nothing scheduled and no turn to end would otherwise never wake her again.
            if (agent.status !== 'running')
                fallbackAlarm();
        }
        catch (error) {
            if (!stopped) {
                faults.set('home', `家打不开：${errorText(error)}`);
                ctx.logger.error(error);
            }
        }
        timer.arm();
    }
    function stop() {
        if (stopped)
            return;
        stopped = true;
        timer.stop();
        for (const dispose of disposers.splice(0).reverse())
            dispose();
        tools.clear();
    }
    /** 面板上「现在叫醒」：走生活线同一条投递路（和闹钟一样），醒来带群里那几条。 */
    async function wakeNow() {
        // 手动叫醒也算“醒来”：新的一天同样先换家，别让这条会话跨天还不换。
        let rotated = false;
        try {
            rotated = deps.beforeWake ? Boolean(await deps.beforeWake()) : false;
        }
        catch { rotated = false; }
        const agent = await home.open();
        const now = clock();
        let digest = '';
        try {
            digest = deps.wakeExtra ? await deps.wakeExtra() : '';
        }
        catch { digest = ''; }
        const text = `（${names().partner}在面板上按了「现在叫醒」）想聊聊就起来说两句，不想动也可以只回一声。` + (rotated ? '\n（新的一天：先给今天取个名字，用 name_today。）' : '') + (rotated ? handoffNote() : '') + (digest ? '\n\n' + digest : '');
        store.appendWake({ scheduledAt: now.toISOString(), deliveredAt: now.toISOString(), source: 'manual', lateMs: 0 });
        await say(agent, text);
    }
    return {
        start, stop, planNext, checkAlarm, cancelAlarm, deliver, wakeNow,
        /** 把家换到一条已有的会话上：别人的鱼想接上自己原来那段对话，就用这个。 */
        adopt(sessionId) {
            state.homeSessionId = sessionId;
            state.greeting = { at: clock().toISOString(), kind: 'arrival' };
            tools.releaseOldHomes();
            store.write(state);
        },
        snapshot: () => ({ homeSessionId: state.homeSessionId, alarm: state.alarm, review: state.review, spend: spendView(), faults: faults.list() }),
        /** Resolves once no alarm delivery is in flight (its durability flush can outlast the turn it starts). */
        settled: async () => { while (delivery)
            await delivery; },
        home: () => home.open(),
        /** Whether this session is her home now; the world prompt gives the home its world line. */
        isHome: (sessionId) => !stopped && sessionId === state.homeSessionId,
    };
}
