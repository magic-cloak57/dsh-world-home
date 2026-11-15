import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { errorText } from "./faults.js";
import { formatLocalTime } from "./timeContext.js";
import { extractLinks, fileRef, localDayStart } from "./memoryStore.js";
const MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_FILES_PER_DIR = 2000;
const sameFile = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;
/** Windows compares paths without case. */
const normalized = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
const within = (root, path) => { const rel = relative(normalized(root), normalized(path)); return rel === '' || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel)); };
const diaryDate = (path) => /(?:^|[\\/])(\d{4}-\d{2}-\d{2})(?:\.[^\\/]*)?$/.exec(path)?.[1];
/**
 * Reads a file the way its text may be used: stat before and after must agree and the bytes must be valid UTF-8. A
 * file that is changing under us, or cannot be read or decoded, is a failure to retry, never new content and never a
 * deletion. A writer that appends valid text piece by piece cannot be told apart from a finished file.
 */
export async function readStable(path, between) {
    try {
        const before = await stat(path);
        if (!before.isFile())
            return { kind: 'failed', message: '不是普通文件' };
        if (before.size > MAX_FILE_BYTES)
            return { kind: 'failed', message: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB，没有读取` };
        const bytes = await readFile(path);
        await between?.();
        const after = await stat(path);
        if (!sameFile(before, after) || bytes.length !== after.size)
            return { kind: 'failed', message: '读取时文件还在变化，下次再试' };
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
        return { kind: 'ok', content, stat: `${after.size}:${after.mtimeMs}`, mtimeMs: after.mtimeMs };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { kind: 'missing' };
        return { kind: 'failed', message: error instanceof TypeError && /encoded data|decode/i.test(error.message) ? '不是有效的 UTF-8 文本' : errorText(error) };
    }
}
/** The diary's own markdown and text files, one level: real paths must stay inside it, so links cannot lead out, and nothing is followed from file contents. */
async function listDirectory(root) {
    let realRoot;
    try {
        realRoot = await realpath(root);
    }
    catch (error) {
        return error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', message: errorText(error) };
    }
    const files = [];
    try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || !/\.(md|txt)$/i.test(entry.name))
                continue;
            const path = join(root, entry.name);
            let target;
            try {
                target = await realpath(path);
            }
            catch {
                continue;
            }
            if (!within(realRoot, target) || !(await stat(path).catch(() => undefined))?.isFile())
                continue;
            if (files.length >= MAX_FILES_PER_DIR)
                throw new Error(`文件超过 ${MAX_FILES_PER_DIR} 个，后面的没有读取`);
            files.push({ path, id: entry.name });
        }
        return { kind: 'ok', files };
    }
    catch (error) {
        return { kind: 'failed', message: errorText(error) };
    }
}
/**
 * What she wrote, read on demand. Files are few and small, so a query looks at the configured places directly; a
 * file whose size and time are unchanged is not read again. A file that cannot be read keeps its last text and is
 * reported; only a file that is really gone leaves the results.
 */
export function createAuthorFiles(sources, timeZone) {
    const cache = new Map();
    const failures = new Map();
    let running, again = false;
    async function load(sourceId, kind, path) {
        const known = cache.get(sourceId);
        if (known?.path === path) {
            const info = await stat(path).catch(() => undefined);
            if (info?.isFile() && `${info.size}:${info.mtimeMs}` === known.stat) {
                failures.delete(sourceId);
                return;
            }
        }
        const result = await readStable(path);
        if (result.kind === 'failed') {
            failures.set(sourceId, `${path}：${result.message}`);
            return;
        }
        failures.delete(sourceId);
        if (result.kind === 'missing' || !result.content.trim())
            cache.delete(sourceId);
        else
            cache.set(sourceId, { kind, path, stat: result.stat, mtimeMs: result.mtimeMs, content: result.content });
    }
    async function loadDirectory(kind, root) {
        const listing = await listDirectory(root);
        const key = `dir:${kind}`;
        if (listing.kind === 'failed') {
            failures.set(key, `${root}：${listing.message}`);
            return;
        }
        failures.delete(key);
        const present = new Set();
        for (const file of listing.kind === 'ok' ? listing.files : []) {
            const sourceId = `${kind}:${file.id}`;
            present.add(sourceId);
            await load(sourceId, kind, file.path);
        }
        for (const [sourceId, entry] of cache)
            if (entry.kind === kind && !present.has(sourceId)) {
                cache.delete(sourceId);
                failures.delete(sourceId);
            }
    }
    async function refreshOnce() {
        const root = sources.diaryDir;
        if (!root)
            return;
        try {
            await loadDirectory('diary', root);
        }
        catch (error) {
            failures.set('dir:diary', `${root}：${errorText(error)}`);
        }
    }
    /** Calls arriving during a refresh join it and make it run once more, so a file saved just now is never missed. */
    function refresh() {
        if (running) {
            again = true;
            return running;
        }
        running = (async () => {
            try {
                do {
                    again = false;
                    await refreshOnce();
                } while (again);
            }
            finally {
                running = undefined;
            }
        })();
        return running;
    }
    function docOf(sourceId, entry) {
        if (entry.doc)
            return entry.doc;
        const date = entry.kind === 'diary' ? diaryDate(entry.path) : undefined;
        const day = date ? localDayStart(date, timeZone) : undefined;
        entry.doc = {
            sourceId, kind: entry.kind, path: entry.path, title: entry.path.replace(/^.*[\\/]/, ''), content: entry.content, ref: fileRef(sourceId, entry.content), links: extractLinks(entry.content),
            timeMs: day?.ms ?? entry.mtimeMs, time: day?.time ?? formatLocalTime(new Date(entry.mtimeMs), timeZone), timeBasis: day ? 'diaryDate' : 'fileObserved',
        };
        return entry.doc;
    }
    /** Every file she has written, as it is now. */
    async function docs() {
        await refresh();
        return [...cache].map(([sourceId, entry]) => docOf(sourceId, entry));
    }
    return { docs, failures: () => [...failures].map(([sourceId, message]) => ({ sourceId, message })) };
}
