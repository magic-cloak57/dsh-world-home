import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 作息：房间里的一个小文件（`作息.json`），三个时间都能手改，插件每分钟读一次。 */
export const DEFAULT_SCHEDULE = { wake: '08:55', diary: '22:35', review: '23:00' };
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIELDS = ['wake', 'diary', 'review'];

export function validClock(value) {
    return typeof value === 'string' && CLOCK.test(value);
}

function minutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

/** `hhmm` 往后推 minutes 分钟，跨午夜也对。 */
export function addClockMinutes(hhmm, byMinutes) {
    const total = (minutes(hhmm) + byMinutes + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function createSchedule({ roomDir, defaults }) {
    const file = join(roomDir, '作息.json');
    const base = { ...DEFAULT_SCHEDULE, ...(defaults || {}) };
    function read() {
        try {
            const data = JSON.parse(readFileSync(file, 'utf8')) || {};
            return {
                wake: validClock(data.wake) ? data.wake : base.wake,
                diary: validClock(data.diary) ? data.diary : base.diary,
                review: validClock(data.review) ? data.review : base.review,
            };
        }
        catch { return { ...base }; }
    }
    /** 只改传进来的几项，其余保持原样；校验不过就抛错，别写坏文件。 */
    function save(patch) {
        const next = read();
        for (const field of FIELDS) {
            if (patch && patch[field] !== undefined) {
                if (!validClock(patch[field]))
                    throw new Error(`${field} 需要 HH:MM（例如 08:55）`);
                next[field] = patch[field];
            }
        }
        if (!existsSync(roomDir))
            mkdirSync(roomDir, { recursive: true });
        writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
        return next;
    }
    return { file, read, save, defaults: base };
}
