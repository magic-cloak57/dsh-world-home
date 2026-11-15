import { jsonObject, knownHost, readBody, sendJson } from "../http.js";
import { PERSONA_LAYERS } from "../persona.js";
import { validTurns, validWechatBuffer, validWechatContext, MAX_WECHAT_BUFFER_SECONDS, MAX_WECHAT_CONTEXT } from "../worldSwitch.js";
import { validArchiveScope } from "../archiveSelection.js";
export const CONSOLE_PREFIX = '/dsh-world';
/** A write must carry this header; a page on another site cannot add it without a CORS preflight, which is never answered. */
export const WRITE_HEADER = 'x-dsh-world';
const MAX_BODY_BYTES = 64 * 1024;
const ok = (body = { ok: true }) => ({ status: 200, body });
const bad = (error) => ({ status: 400, body: { error } });
function persona(body) {
    if (!body)
        return undefined;
    const entries = Object.entries(body);
    if (!entries.every(([key, value]) => PERSONA_LAYERS.includes(key) && typeof value === 'string'))
        return undefined;
    return Object.fromEntries(entries);
}
async function write(actions, path, body) {
    switch (path) {
        case '/console/start':
            await actions.start();
            return ok();
        case '/console/stop':
            await actions.stop();
            return ok();
        case '/console/qq': return ok(actions.saveQq(body || {}));
        case '/console/restore': return ok(actions.backupRestore({ dir: body?.dir, dry: body?.dry !== false, drive: body?.drive }));
        case '/console/backup': return ok(actions.backupRun({ dir: body?.dir, dry: body?.dry === true }));
        case '/console/wake':
            await actions.wake();
            return ok();
        case '/console/home': {
            const sessionId = body?.sessionId;
            if (typeof sessionId !== 'string' || !sessionId)
                return bad('sessionId is required');
            await actions.setHome(sessionId);
            return ok();
        }
        case '/console/home-location': {
            const drive = body?.drive;
            if (typeof drive !== 'string')
                return bad('drive must be a drive letter like "E"');
            const result = actions.setHomeLocation(drive);
            return result?.error ? bad(result.error) : ok({ ok: true, ...result });
        }
        case '/console/persona': {
            const layers = persona(body);
            if (!layers)
                return bad('persona layers must be strings');
            actions.savePersona(layers);
            return ok();
        }
        case '/console/schedule': {
            try {
                return ok({ ok: true, schedule: actions.setSchedule(body || {}) });
            }
            catch (error) {
                return bad(String(error?.message ?? error));
            }
        }
        case '/console/budget': {
            const daily = body?.daily;
            if (daily !== null && (typeof daily !== 'number' || !Number.isFinite(daily) || daily < 0))
                return bad('daily must be a non-negative number or null');
            actions.setDailyBudget(daily === null ? undefined : daily);
            return ok();
        }
        case '/console/memory': {
            const turns = body?.turns;
            if (turns !== null && !validTurns(turns))
                return bad('turns must be a whole number of at least 1, or null');
            actions.setMemoryTurns(turns === null ? undefined : turns);
            return ok();
        }
        case '/console/wechat': {
            const context = body?.contextMessages, bufferSeconds = body?.bufferSeconds;
            if (context !== undefined && context !== null && !validWechatContext(context))
                return bad(`contextMessages must be a whole number from 1 to ${MAX_WECHAT_CONTEXT}, or null`);
            if (bufferSeconds !== undefined && bufferSeconds !== null && !validWechatBuffer(bufferSeconds))
                return bad(`bufferSeconds must be a number from 0 to ${MAX_WECHAT_BUFFER_SECONDS}, or null`);
            if (context === undefined && bufferSeconds === undefined)
                return bad('nothing to change');
            actions.setWechatSettings({ ...(context === undefined ? {} : { context }), ...(bufferSeconds === undefined ? {} : { bufferSeconds }) });
            return ok();
        }
        case '/console/modules': {
            const wechat = body?.wechat, qq = body?.qq, bili = body?.bili;
            if ((wechat !== undefined && typeof wechat !== 'boolean') || (qq !== undefined && typeof qq !== 'boolean') || (bili !== undefined && typeof bili !== 'boolean'))
                return bad('wechat、qq、bili 必须是 true 或 false');
            if (wechat === undefined && qq === undefined && bili === undefined)
                return bad('nothing to change');
            const refused = await actions.setModules({ ...(wechat === undefined ? {} : { wechat }), ...(qq === undefined ? {} : { qq }), ...(bili === undefined ? {} : { bili }) });
            return refused ? bad(refused) : ok();
        }
        case '/console/wechat-adapter': return await actions.restartWechatAdapter() ? ok() : bad('适配器不是由插件管理的，请在配置里写 wechatAdapter');
        case '/console/archive-scope': {
            if (!validArchiveScope(body?.scope))
                return bad('scope must be home or workspace');
            return ok({ ok: true, restartRequired: actions.setArchiveScope(body.scope) });
        }
        case '/console/world-prompt': {
            if (typeof body?.text !== 'string')
                return bad('text must be a string');
            actions.saveWorldPrompt(body.text);
            return ok();
        }
        default: return { status: 404, body: { error: 'not found' } };
    }
}
/** Reads are open to the console page; writes need POST, the write header and a JSON body. */
export async function handleConsole(sources, actions, request) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== CONSOLE_PREFIX && !url.pathname.startsWith(CONSOLE_PREFIX + '/'))
        return { status: 404, body: { error: 'not found' } };
    const path = url.pathname.slice(CONSOLE_PREFIX.length);
    if (request.method === 'POST') {
        if (!request.write)
            return { status: 403, body: { error: 'forbidden' } };
        return write(actions, path, request.body);
    }
    if (request.method !== 'GET')
        return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET, POST' } };
    switch (path) {
        case '/console/snapshot': return ok(await sources.snapshot());
        case '/console/activity': return ok(sources.activity(url.searchParams.get('day') ?? '', url.searchParams.get('outside') === '1'));
        case '/console/diary': {
            const date = url.searchParams.get('date') ?? '';
            const text = sources.diary(date);
            return text === undefined ? { status: 404, body: { error: 'no diary for this date' } } : ok({ date, text });
        }
        case '/console/prompts': return ok(actions.prompts());
        case '/console/drives': return ok({ drives: actions.listDrives() });
        case '/console/qq': return ok(actions.getQq());
        case '/console/backup': return ok(actions.backupInfo());
        case '/console/restore': {
            const dir = url.searchParams.get('dir') || '';
            return ok(actions.backupInspect(dir));
        }
        case '/console/persona-presets': {
            try {
                const { readFileSync } = await import('node:fs');
                const { fileURLToPath } = await import('node:url');
                const { dirname, join } = await import('node:path');
                const here = dirname(fileURLToPath(import.meta.url));
                const file = join(here, '..', '..', 'presets', 'seed-personas.json');
                const data = JSON.parse(readFileSync(file, 'utf8'));
                return ok({ presets: Array.isArray(data.presets) ? data.presets : [] });
            }
            catch (error) {
                return ok({ presets: [], error: String(error?.message ?? error) });
            }
        }
        case '/console/sessions': return ok({ sessions: await actions.listSessions() });
        default: return { status: 404, body: { error: 'not found' } };
    }
}
export function consoleRoute(sources, actions, allowedHosts = []) {
    return {
        kind: 'prefix', path: CONSOLE_PREFIX,
        handler: async (req, res) => {
            let result;
            try {
                if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts))
                    result = { status: 403, body: { error: 'cross-site requests are not allowed' } };
                else {
                    const method = req.method ?? 'GET';
                    const write = method === 'POST' && req.headers[WRITE_HEADER] === '1' && String(req.headers['content-type'] ?? '').startsWith('application/json');
                    const body = write ? jsonObject(await readBody(req, MAX_BODY_BYTES)) : undefined;
                    result = write && body === undefined ? bad('a JSON object body is required') : await handleConsole(sources, actions, { method, url: req.url ?? '/', write, body });
                }
            }
            catch {
                result = { status: 500, body: { error: 'internal error' } };
            }
            sendJson(res, result);
        },
    };
}
