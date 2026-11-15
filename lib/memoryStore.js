import { createHash } from 'node:crypto';
import { formatLocalTime } from "./timeContext.js";
export const MEMORY_KINDS = ['conversation', 'diary'];
export class MemoryError extends Error {
    code;
    constructor(code, message, options) { super(message, options); this.name = 'MemoryError'; this.code = code; }
}
export const MAX_QUERY_CHARS = 200;
export const EXCERPT_CHARS = 300;
const MAX_LINKS_PER_DOC = 200;
export const sha = (text) => createHash('sha256').update(text).digest('hex');
const encodeRef = (parts) => 'm1.' + Buffer.from(JSON.stringify(parts)).toString('base64url');
export function decodeRef(ref) {
    try {
        if (!ref.startsWith('m1.'))
            throw new Error('prefix');
        const parts = JSON.parse(Buffer.from(ref.slice(3), 'base64url').toString('utf8'));
        if (Array.isArray(parts) && typeof parts[1] === 'string' && typeof parts[2] === 'string') {
            if (parts[0] === 'c')
                return { kind: 'c', recordId: parts[1], hash: parts[2] };
            if (parts[0] === 'a')
                return { kind: 'a', sourceId: parts[1], hash: parts[2] };
        }
    }
    catch { /* falls through */ }
    throw new MemoryError('invalidRef', '引用无效：这不是 memory_find 给出的 ref');
}
/** A ref is bound to the text it showed, so a revised line or an edited file is told apart from the one that was cited. */
const hashOf = (content) => sha(content).slice(0, 12);
export const chatRef = (recordId, content) => encodeRef(['c', recordId, hashOf(content)]);
export const fileRef = (sourceId, content) => encodeRef(['a', sourceId, hashOf(content)]);
/** Explicit links only: a line `引用：memory:<ref> memory:<ref>`. */
export function extractLinks(content) {
    const found = new Set();
    for (const line of content.matchAll(/^引用[：:][ \t]*(.+)$/gm)) {
        for (const token of line[1].matchAll(/memory:(m1\.[A-Za-z0-9_-]+)/g)) {
            found.add(token[1]);
            if (found.size >= MAX_LINKS_PER_DOC)
                return [...found];
        }
    }
    return [...found];
}
/** The instant a local calendar day starts in the zone, with the offset it has then. */
export function localDayStart(date, timeZone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return undefined;
    const guess = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 10) !== date)
        return undefined;
    const offsetMs = (at) => { const text = formatLocalTime(new Date(at), timeZone); return Date.parse(text.slice(0, 19) + 'Z') - Math.floor(at / 1000) * 1000; };
    let ms = guess - offsetMs(guess);
    ms = guess - offsetMs(ms);
    const time = formatLocalTime(new Date(ms), timeZone);
    return { ms, time: time.startsWith(date) ? time : `${date}T00:00:00${time.slice(19)}` };
}
/** A window of `EXCERPT_CHARS` characters around the first match (or the start), cut on whole characters. */
export function excerptOf(content, query) {
    const at = query ? Math.max(0, content.indexOf(query)) : 0;
    const lead = Array.from(content.slice(Math.max(0, at - 400), at)).length;
    const from = Math.max(0, lead - 100);
    return Array.from(content.slice(Math.max(0, at - 400), at + 1200)).slice(from, from + EXCERPT_CHARS).join('');
}
const originOf = (record) => ({
    sessionId: record.sourceSessionId, role: record.role,
    ...(record.speakerId ? { speakerId: record.speakerId } : {}), ...(record.speakerName ? { speakerName: record.speakerName } : {}), ...(record.channel ? { channel: record.channel } : {}),
    ...(record.conversationId ? { conversationId: record.conversationId } : {}), ...(record.conversationName ? { conversationName: record.conversationName } : {}), ...(record.conversationType ? { conversationType: record.conversationType } : {}),
});
/** SQLite's own normal form of a timestamp (UTC, milliseconds), so lines stored with any offset compare as the same instants. */
const SQL_INSTANT = "strftime('%Y-%m-%dT%H:%M:%f', occurredAt)";
const instant = (ms) => new Date(ms).toISOString().slice(0, 23);
const SESSION = "json_extract(body, '$.sourceSessionId')";
/**
 * Chat lines are searched where they already are: the archive's `records` table, by scanning. Nothing is copied or
 * indexed, so there is nothing to build, migrate or rebuild; an archive from before this existed answers at once.
 */
export function createMemoryStore(db, deps) {
    const { timeZone } = deps;
    /** Bumped when a stored line is revised, so a page cursor taken before the revision no longer applies. */
    let revisions = 0;
    let sessionCache;
    const head = () => Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM records').get()?.n);
    const recordOf = (body) => JSON.parse(body);
    /** The newest line the archive has; a page cursor stays inside the lines that existed when it was taken. */
    const snapshot = () => ({ head: head(), revisions });
    const revised = () => { revisions++; };
    /** Chat sessions that have lines; the caller decides which of them it may see. */
    function sessionIds() {
        const now = head();
        if (sessionCache?.head !== now)
            sessionCache = { head: now, ids: db.prepare(`SELECT DISTINCT ${SESSION} AS sessionId FROM records`).all().map(row => row.sessionId) };
        return sessionCache.ids;
    }
    /** The matching lines of the given sessions in the asked order, at most `take` of them, never past `upTo`. */
    function find(params, sessions, upTo, take) {
        const where = [`${SESSION} IN (SELECT value FROM json_each(?))`, 'sequence<=?'];
        const values = [JSON.stringify(sessions), upTo];
        if (params.sourceId) {
            where.push(`${SESSION}=?`);
            values.push(params.sourceId.slice('chat:'.length));
        }
        if (params.fromMs !== undefined) {
            where.push(`${SQL_INSTANT}>=?`);
            values.push(instant(params.fromMs));
        }
        if (params.toMs !== undefined) {
            where.push(`${SQL_INSTANT}<?`);
            values.push(instant(params.toMs));
        }
        if (params.turnId) {
            where.push('turnId=?');
            values.push(params.turnId);
        }
        if (params.query) {
            where.push("instr(json_extract(body, '$.content'), ?)>0");
            values.push(params.query);
        }
        const way = params.order === 'newest' ? 'DESC' : 'ASC';
        const order = params.turnId ? `sourceSeq ${way}, sequence ${way}` : `day ${way}, occurredAt ${way}, recordId ${way}`;
        const rows = db.prepare(`SELECT body FROM records WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...values, take);
        return rows.map(row => recordOf(row.body));
    }
    function item(record, query) {
        const timeMs = Date.parse(record.occurredAt);
        return {
            ref: chatRef(record.recordId, record.content), sourceId: `chat:${record.sourceSessionId}`, kind: 'conversation', title: record.speakerName ?? (record.role === 'assistant' ? 'assistant' : 'user'),
            time: formatLocalTime(new Date(timeMs), timeZone), timeBasis: 'message', current: true, excerpt: excerptOf(record.content, query), turnId: record.turnId, origin: originOf(record),
        };
    }
    const byRecordId = (recordId) => {
        const row = db.prepare('SELECT body FROM records WHERE recordId=? LIMIT 1').get(recordId);
        return row && recordOf(row.body);
    };
    /** The chat session a ref points into, when it is a chat line that still exists. */
    function refSession(ref) {
        const decoded = decodeRef(ref);
        return decoded.kind === 'c' ? byRecordId(decoded.recordId)?.sourceSessionId : undefined;
    }
    /** What a chat ref points at, if the caller may see its session and the line still reads as it did when cited. */
    function read(ref, canSee) {
        const decoded = decodeRef(ref);
        if (decoded.kind !== 'c')
            throw new MemoryError('invalidRef', '这不是聊天的引用');
        const record = byRecordId(decoded.recordId);
        if (!record)
            throw new MemoryError('notFound', '这条引用对应的聊天不存在');
        if (!canSee(record.sourceSessionId))
            throw new MemoryError('outOfScope', '这条聊天不在当前可读范围内');
        if (hashOf(record.content) !== decoded.hash)
            throw new MemoryError('sourceChanged', '这条聊天在引用之后被修订过，旧版正文没有保留（sourceChanged）');
        const timeMs = Date.parse(record.occurredAt);
        return {
            ref, sourceId: `chat:${record.sourceSessionId}`, kind: 'conversation', version: decoded.hash, title: record.speakerName ?? record.role, time: formatLocalTime(new Date(timeMs), timeZone),
            timeBasis: 'message', current: true, content: record.content, turnId: record.turnId, origin: originOf(record),
        };
    }
    return { find, item, byRecordId, refSession, read, sessionIds, snapshot, revised };
}
