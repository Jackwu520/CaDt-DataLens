// ai-gen-jobs.js：生图/视频生成运行时——同步执行与异步任务注册表。
// 模板渲染/提取/参数合并走 ai-gen-model.js 纯函数；HTTP 与落盘走 Go 哑通道
// （AIGenHTTPRequest / AIGenSaveProducts）。异步任务在前端轮询（submit → jobId →
// pollPath 到点取产物），完成后经 ctx.onJobDone 唤醒归属会话（ai-agent-notices 信箱）；
// ctx.onJobUpdate 刷新工具卡。轮询不跨重启：normalizeMessage 恢复时运行中任务收敛为失败。
import {aiNowId} from './ai-constants.js';
import {
    buildGenVars,
    extractGenPath,
    GEN_BODY_LIMIT,
    genHeaderMap,
    genJoinURL,
    genModelByRef,
    isAsyncGenModel,
    normalizeGenSnapshot,
    renderGenJson,
    renderGenText,
} from './ai-gen-model.js';

const GEN_MAX_JOBS = 16;        // 全局运行中任务上限
const GEN_MAX_PER_SESSION = 4;  // 单会话运行中任务上限
const GEN_POLL_ERROR_BUDGET = 3; // 连续轮询失败容忍（瞬时网络错误不杀死任务）

export function createAIGenJobs(ctx) {

    const jobs = new Map(); // jobId -> job

    function getBackend() {
        const backend = typeof ctx.getBackend === 'function' ? ctx.getBackend() : ctx.backend;
        if (!backend) throw new Error('后端通道不可用');
        return backend;
    }

    function snapshotOf(job) {
        return {
            jobId: job.id,
            kind: job.kind,
            entryName: job.entryName,
            status: job.status,
            progressText: job.progressText,
            error: job.error,
            files: job.files,
        };
    }

    function updateJob(job) {
        if (job.toolMessage) job.toolMessage.gen = normalizeGenSnapshot(snapshotOf(job));
        if (typeof ctx.onJobUpdate === 'function') ctx.onJobUpdate(job);
    }

    function finishJob(job, status, error) {
        if (job._timer) clearTimeout(job._timer);
        job._timer = 0;
        if (job.status === 'running') {
            job.status = status;
            if (error) job.error = String(error);
            job.finishedAt = Date.now();
        }
        updateJob(job);
        if (job.status === 'done' || job.status === 'failed') {
            if (typeof ctx.onJobDone === 'function') ctx.onJobDone(job);
        }
    }

    function runningJobs() {
        return [...jobs.values()].filter((job) => job.status === 'running');
    }

    function assertJobSlots(sessionId) {
        const running = runningJobs();
        if (running.length >= GEN_MAX_JOBS) throw new Error('生成任务过多（全局上限 ' + GEN_MAX_JOBS + '），请稍后再试');
        const mine = running.filter((job) => job.sessionId === sessionId).length;
        if (mine >= GEN_MAX_PER_SESSION) throw new Error('本会话生成任务过多（上限 ' + GEN_MAX_PER_SESSION + '），等完成或 check_gen 查看进度');
    }

    // ---------- 共用：单次请求 / 错误提取 / 产物落盘 ----------

    function assertOk(resp, entry) {
        if (resp && resp.error) throw new Error(resp.error);
        if (entry && entry.errorPath) {
            let parsed = null;
            try {
                parsed = JSON.parse(resp && resp.body || '');
            } catch (e) {
                parsed = null;
            }
            if (parsed) {
                const errors = extractGenPath(parsed, entry.errorPath);
                if (errors.length && String(errors[0]).trim()) {
                    throw new Error('服务端返回错误：' + String(errors[0]).trim());
                }
            }
        }
        if (resp && resp.status >= 400) {
            throw new Error('HTTP ' + resp.status + '：' + String((resp && resp.body) || '').slice(0, 300));
        }
    }

    function parseRespJSON(resp) {
        try {
            return JSON.parse(resp.body || '');
        } catch (e) {
            throw new Error('响应不是合法 JSON（HTTP ' + (resp.status || 0) + '）');
        }
    }

    async function saveProducts(workspace, entry, params, values) {
        const items = values.slice(0, 16).map((value) => entry.resultType === 'url'
            ? {type: 'url', url: String(value)}
            : {type: 'b64', data: String(value)});
        if (!items.length) throw new Error('没有可落盘的产物');
        const backend = getBackend();
        if (!backend.AIGenSaveProducts) throw new Error('生成产物落盘通道不可用（请重新构建或更新应用）');
        const result = await backend.AIGenSaveProducts(JSON.stringify({
            workspace,
            outputPath: params.outputPath || '',
            kind: entry.kind,
            proxy: entry.proxy,
            timeoutSec: entry.kind === 'video' ? 300 : 120,
            items,
        }));
        if (result && result.error) throw new Error(result.error);
        return (result && result.files) || [];
    }

    // ---------- 同步型条目：阻塞到产物落盘 ----------

    async function runSync(workspace, entry, params) {
        const vars = buildGenVars(entry, params);
        const backend = getBackend();
        if (!backend.AIGenHTTPRequest) throw new Error('生成请求通道不可用（请重新构建或更新应用）');
        const resp = await backend.AIGenHTTPRequest(JSON.stringify({
            url: genJoinURL(entry.baseURL, entry.path),
            method: 'POST',
            headers: genHeaderMap(entry, vars),
            body: renderGenJson(entry.bodyTemplate, vars),
            proxy: entry.proxy,
            timeoutSec: entry.timeoutSec,
            maxBytes: GEN_BODY_LIMIT,
        }));
        assertOk(resp, entry);
        const parsed = parseRespJSON(resp);
        const values = extractGenPath(parsed, entry.resultPath);
        if (!values.length) throw new Error('响应里没有提取到产物（resultPath ' + (entry.resultPath || '未配置') + ' 未命中）');
        return saveProducts(workspace, entry, params, values);
    }

    // ---------- 异步型条目：提交 → 后台轮询 → 落盘 → 通知 ----------

    async function submitJob(workspace, sessionId, entry, params, toolMessage) {
        assertJobSlots(sessionId);
        if (!isAsyncGenModel(entry)) throw new Error('该条目不是异步型（未配置提交/轮询端点）');
        const vars = buildGenVars(entry, params);
        const backend = getBackend();
        if (!backend.AIGenHTTPRequest) throw new Error('生成请求通道不可用（请重新构建或更新应用）');
        const job = {
            id: aiNowId('genjob-'),
            kind: entry.kind,
            entryId: entry.id,
            entryName: entry.name || entry.defaultModel || '生成条目',
            sessionId,
            workspace,
            status: 'running',
            stage: 'submit',
            progressText: '提交任务…',
            error: '',
            files: [],
            pollCount: 0,
            pollErrors: 0,
            maxPolls: entry.maxPolls,
            createdAt: Date.now(),
            finishedAt: 0,
            toolMessage: toolMessage || null,
            _timer: 0,
        };
        jobs.set(job.id, job);
        updateJob(job);
        try {
            const resp = await backend.AIGenHTTPRequest(JSON.stringify({
                url: genJoinURL(entry.baseURL, entry.submitPath),
                method: 'POST',
                headers: genHeaderMap(entry, vars),
                body: renderGenJson(entry.bodyTemplate, vars),
                proxy: entry.proxy,
                timeoutSec: entry.timeoutSec,
                maxBytes: GEN_BODY_LIMIT,
            }));
            assertOk(resp, entry);
            const parsed = parseRespJSON(resp);
            const ids = extractGenPath(parsed, entry.jobIdPath);
            if (!ids.length) throw new Error('提交响应里没有提取到任务 id（jobIdPath 未命中）');
            job.jobIdRemote = String(ids[0]);
            job.stage = 'poll';
            job.progressText = '已提交，等待服务端处理…';
            updateJob(job);
        } catch (e) {
            jobs.delete(job.id);
            throw e;
        }
        schedulePoll(job, entry, params, entry.pollIntervalSec * 1000);
        return job.id;
    }

    function schedulePoll(job, entry, params, delayMs) {
        if (job.status !== 'running') return;
        job._timer = setTimeout(() => {
            pollOnce(job, entry, params).catch((e) => {
                // 瞬时网络错误不立刻杀死任务：连续超预算才判失败
                job.pollErrors = (job.pollErrors || 0) + 1;
                if (job.pollErrors >= GEN_POLL_ERROR_BUDGET) {
                    failJob(job, '轮询失败：' + ((e && e.message) || e));
                } else {
                    schedulePoll(job, entry, params, entry.pollIntervalSec * 1000);
                }
            });
        }, Math.max(1000, delayMs));
    }

    async function pollOnce(job, entry, params) {
        if (job.status !== 'running') return;
        job.pollCount++;
        const vars = buildGenVars(entry, params);
        vars.jobId = job.jobIdRemote || '';
        const backend = getBackend();
        const resp = await backend.AIGenHTTPRequest(JSON.stringify({
            url: genJoinURL(entry.baseURL, renderGenText(entry.pollPath, vars)),
            method: 'GET',
            headers: genHeaderMap(entry, vars),
            proxy: entry.proxy,
            timeoutSec: Math.min(entry.timeoutSec, 60),
            maxBytes: GEN_BODY_LIMIT,
        }));
        assertOk(resp, entry);
        job.pollErrors = 0;
        const parsed = parseRespJSON(resp);
        let settled = false;
        if (entry.statusPath) {
            const states = extractGenPath(parsed, entry.statusPath);
            const state = states.length ? String(states[0]).trim() : '';
            if (state && entry.failedValue && state === entry.failedValue) {
                failJob(job, '服务端任务失败（状态 ' + state + '）');
                return;
            }
            if (state && entry.doneValue && state !== entry.doneValue) {
                job.progressText = '服务端状态：' + state;
                updateJob(job);
                settled = false;
            } else if (state) {
                settled = true; // 状态到 doneValue（或未配 doneValue 时只要有状态就尝试取产物）
            }
        }
        if (settled || !entry.statusPath) {
            const values = extractGenPath(parsed, entry.resultPath);
            if (values.length) {
                job.stage = 'save';
                job.progressText = '取回产物中…';
                updateJob(job);
                job.files = await saveProducts(job.workspace, entry, params, values);
                finishJob(job, 'done');
                return;
            }
        }
        if (job.pollCount >= job.maxPolls) {
            failJob(job, '轮询超上限（' + job.maxPolls + ' 次），任务仍未完成');
            return;
        }
        schedulePoll(job, entry, params, entry.pollIntervalSec * 1000);
    }

    function failJob(job, message) {
        finishJob(job, 'failed', message);
    }

    // ---------- 查询 / 停止 ----------

    function checkJob(jobId) {
        const job = jobs.get(String(jobId || '').trim());
        if (!job) return null;
        return {job, snapshot: normalizeGenSnapshot(snapshotOf(job))};
    }

    function stopJob(jobId) {
        const job = jobs.get(String(jobId || '').trim());
        if (!job || job.status !== 'running') return false;
        finishJob(job, 'stopped');
        return true;
    }

    function stopAll() {
        for (const job of runningJobs()) finishJob(job, 'stopped');
    }

    function jobsForSession(sessionId) {
        return [...jobs.values()].filter((job) => job.sessionId === sessionId);
    }

    return {
        runSync,
        submitJob,
        checkJob,
        stopJob,
        stopAll,
        jobsForSession,
        runningCount: () => runningJobs().length,
    };
}
