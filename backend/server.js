const express = require('express');
const https   = require('https');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;
const NODE = process.env.PVE_NODE || 'pve01';

const agent = new https.Agent({ rejectUnauthorized: false });
const pve   = axios.create({
  baseURL:    `${process.env.PVE_HOST}/api2/json`,
  httpsAgent: agent,
  headers:    { Authorization: `PVEAPIToken=${process.env.PVE_TOKEN_ID}=${process.env.PVE_TOKEN_SECRET}` },
  timeout:    30000,
});

app.use(cors());
app.use(express.json());
app.use('/api', (_, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, '../frontend')));

const get   = p      => pve.get(p).then(r => r.data.data);
const post  = (p, d) => pve.post(p, d).then(r => r.data.data);
const put   = (p, d) => pve.put(p, d).then(r => r.data.data);
const del   = p      => pve.delete(p).then(r => r.data.data);
const sleep = ms     => new Promise(r => setTimeout(r, ms));

async function waitTask(upid, max = 180000) {
  const enc = encodeURIComponent(upid);
  const t0  = Date.now();
  while (Date.now() - t0 < max) {
    const s = await get(`/nodes/${NODE}/tasks/${enc}/status`);
    if (s.status === 'stopped') {
      if (s.exitstatus && s.exitstatus !== 'OK') throw new Error('Task falhou: ' + s.exitstatus);
      return s;
    }
    await sleep(2000);
  }
  throw new Error('Task timeout');
}

app.get('/api/health', (_, res) => res.json({ ok: true, node: NODE }));

app.get('/api/node/status', async (req, res) => {
  try {
    const [status, storage] = await Promise.all([
      get(`/nodes/${NODE}/status`),
      get(`/nodes/${NODE}/storage`),
    ]);
    res.json({ status, storage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vms', async (req, res) => {
  try { res.json((await get(`/nodes/${NODE}/qemu`)).sort((a, b) => a.vmid - b.vmid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/vms/:id/config', async (req, res) => {
  try {
    const [current, config] = await Promise.all([
      get(`/nodes/${NODE}/qemu/${req.params.id}/status/current`),
      get(`/nodes/${NODE}/qemu/${req.params.id}/config`),
    ]);
    res.json({ current, config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

['start', 'stop', 'shutdown', 'reboot'].forEach(action => {
  app.post(`/api/vms/:id/${action}`, async (req, res) => {
    try { res.json(await post(`/nodes/${NODE}/qemu/${req.params.id}/status/${action}`)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
});

app.get('/api/vms/:id/console-url', (req, res) => {
  const url = `${process.env.PVE_HOST}/?console=kvm&novnc=1&node=${NODE}&vmid=${req.params.id}`;
  res.json({ url });
});

app.put('/api/vms/:id/config', async (req, res) => {
  try {
    const allowed = ['cores', 'memory', 'name', 'description', 'balloon'];
    const body = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) body[k] = req.body[k]; });
    res.json(await put(`/nodes/${NODE}/qemu/${req.params.id}/config`, body));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vms/:id/resize', async (req, res) => {
  try { res.json(await put(`/nodes/${NODE}/qemu/${req.params.id}/resize`, req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/vms/:id', async (req, res) => {
  try {
    const { force } = req.query;
    const current = await get(`/nodes/${NODE}/qemu/${req.params.id}/status/current`);
    if (current.status === 'running') {
      if (!force) return res.status(409).json({ error: 'VM está rodando. Use force=true para forçar a exclusão ou desligue-a primeiro.', status: 'running' });
      const stopUpid = await post(`/nodes/${NODE}/qemu/${req.params.id}/status/stop`);
      await waitTask(stopUpid);
    }
    const upid = await del(`/nodes/${NODE}/qemu/${req.params.id}?purge=1&destroy-unreferenced-disks=1`);
    await waitTask(upid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BACKUPS ───────────────────────────────────────────────────────────────────
app.get('/api/vms/:id/backups', async (req, res) => {
  try {
    const storages = await get(`/nodes/${NODE}/storage`);
    const backupStors = storages.filter(s => s.active && s.content && s.content.includes('backup'));
    const results = [];
    for (const stor of backupStors) {
      try {
        const content = await get(`/nodes/${NODE}/storage/${stor.storage}/content?content=backup&vmid=${req.params.id}`);
        results.push(...content.map(b => ({ ...b, storage: stor.storage })));
      } catch (_) {}
    }
    results.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vms/:id/backup', async (req, res) => {
  try {
    const { storage = 'local', mode = 'snapshot', compress = 'zstd', notes } = req.body;
    const body = { vmid: req.params.id, storage, mode, compress };
    if (notes) body.notes = notes;
    const upid = await post(`/nodes/${NODE}/vzdump`, body);
    res.json({ upid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backups/task/:upid', async (req, res) => {
  try {
    const enc = encodeURIComponent(req.params.upid);
    const status = await get(`/nodes/${NODE}/tasks/${enc}/status`);
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backups/restore', async (req, res) => {
  try {
    const { volid, vmid, storage, start = false } = req.body;
    if (!volid || !vmid) return res.status(400).json({ error: 'volid e vmid são obrigatórios' });
    const body = { archive: volid, vmid: parseInt(vmid), storage: storage || 'local-lvm', start: start ? 1 : 0, 'unique': 1 };
    const upid = await post(`/nodes/${NODE}/qemu`, body);
    res.json({ upid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/backups', async (req, res) => {
  try {
    const { volid, storage } = req.body;
    if (!volid || !storage) return res.status(400).json({ error: 'volid e storage são obrigatórios' });
    const enc = encodeURIComponent(volid);
    await del(`/nodes/${NODE}/storage/${storage}/content/${enc}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BACKUP JOBS (scheduled) ────────────────────────────────────────────────────
app.get('/api/backup-jobs', async (req, res) => {
  try {
    const jobs = await get('/cluster/backup');
    res.json(jobs || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backup-jobs', async (req, res) => {
  try {
    const { storage, vmid, schedule, mode, compress, enabled, comment, node,
      'keep-last': kLast, 'keep-hourly': kHourly, 'keep-daily': kDaily,
      'keep-weekly': kWeekly, 'keep-monthly': kMonthly, 'keep-yearly': kYearly } = req.body;
    if (!storage || !schedule) return res.status(400).json({ error: 'storage e schedule são obrigatórios' });
    const body = { storage, schedule, mode: mode || 'snapshot', compress: compress || 'zstd', enabled: enabled === false ? 0 : 1 };
    if (vmid)    body.vmid    = vmid;
    if (comment) body.comment = comment;
    if (node)    body.node    = node;
    const ret = { 'keep-last': kLast, 'keep-hourly': kHourly, 'keep-daily': kDaily, 'keep-weekly': kWeekly, 'keep-monthly': kMonthly, 'keep-yearly': kYearly };
    Object.entries(ret).forEach(([k, v]) => { if (v && parseInt(v) > 0) body[k] = parseInt(v); });
    const result = await post('/cluster/backup', body);
    res.json({ ok: true, id: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup-jobs/:id', async (req, res) => {
  try {
    const job = await get(`/cluster/backup/${req.params.id}`);
    res.json(job || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/backup-jobs/:id', async (req, res) => {
  try {
    const { storage, vmid, schedule, mode, compress, enabled, comment,
      'keep-last': kLast, 'keep-hourly': kHourly, 'keep-daily': kDaily,
      'keep-weekly': kWeekly, 'keep-monthly': kMonthly, 'keep-yearly': kYearly } = req.body;
    const body = {};
    if (storage  !== undefined) body.storage  = storage;
    if (vmid     !== undefined) body.vmid     = vmid || '';
    if (schedule !== undefined) body.schedule = schedule;
    if (mode     !== undefined) body.mode     = mode;
    if (compress !== undefined) body.compress = compress;
    if (enabled  !== undefined) body.enabled  = enabled ? 1 : 0;
    if (comment  !== undefined) body.comment  = comment || '';
    const ret = { 'keep-last': kLast, 'keep-hourly': kHourly, 'keep-daily': kDaily, 'keep-weekly': kWeekly, 'keep-monthly': kMonthly, 'keep-yearly': kYearly };
    Object.entries(ret).forEach(([k, v]) => { if (v !== undefined) body[k] = parseInt(v) || 0; });
    await put(`/cluster/backup/${req.params.id}`, body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/backup-jobs/:id', async (req, res) => {
  try {
    await del(`/cluster/backup/${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TASK LOGS ─────────────────────────────────────────────────────────────────
app.get('/api/vms/:id/tasks', async (req, res) => {
  try {
    const tasks = await get(`/nodes/${NODE}/tasks?vmid=${req.params.id}&limit=50`);
    res.json(tasks || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tasks/:upid/log', async (req, res) => {
  try {
    const enc = encodeURIComponent(decodeURIComponent(req.params.upid));
    const log = await get(`/nodes/${NODE}/tasks/${enc}/log?limit=1000`);
    res.json(log || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tasks/:upid/status', async (req, res) => {
  try {
    const enc = encodeURIComponent(decodeURIComponent(req.params.upid));
    const status = await get(`/nodes/${NODE}/tasks/${enc}/status`);
    res.json(status || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/storage', async (req, res) => {
  try { res.json(await get(`/nodes/${NODE}/storage`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/templates', async (req, res) => {
  try { res.json((await get(`/nodes/${NODE}/qemu`)).filter(v => v.template === 1)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CREATE VM — SSE progress stream ──────────────────────────────────────────
app.post('/api/vms/create', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sse = (pct, msg, extra = {}) =>
    res.write(`data: ${JSON.stringify({ pct, msg, ...extra })}\n\n`);

  const { vmid, name, cores, memory, diskSize, storage,
          template, ciuser, cipassword, sshkeys, ipconfig, gateway } = req.body;

  const UTPL = parseInt(process.env.UBUNTU_TEMPLATE_ID || '9000');
  const WTPL = parseInt(process.env.WIN_TEMPLATE_ID    || '9001');
  const tplId = template === 'ubuntu' ? UTPL : WTPL;
  const stor  = storage || 'local-lvm';

  try {
    // 1 — clone template
    sse(5, `Clonando template ${tplId} → VM ${vmid}...`);
    const cloneUpid = await post(`/nodes/${NODE}/qemu/${tplId}/clone`, {
      newid: parseInt(vmid), name, full: 1, storage: stor,
    });
    await waitTask(cloneUpid);
    sse(30, 'Clone concluído.');

    // 2 — resize disk (before cloud-init so OS sees the right size)
    const dk = parseInt(diskSize) || 0;
    if (dk > 0) {
      sse(38, `Redimensionando disco para ${dk} GiB...`);
      try {
        await put(`/nodes/${NODE}/qemu/${vmid}/resize`, { disk: 'scsi0', size: `${dk}G` });
        sse(46, `Disco: ${dk} GiB OK.`);
      } catch (e) {
        sse(46, 'Disco mantido (tamanho já adequado).');
      }
    }

    // 3 — cloud-init + CPU + RAM
    sse(52, 'Configurando Cloud-Init, CPU e RAM...');
    const cfg = {
      cores:     parseInt(cores)  || 2,
      memory:    parseInt(memory) || 2048,
      agent:     'enabled=1',
      ipconfig0: (ipconfig && gateway) ? `ip=${ipconfig},gw=${gateway}` : 'ip=dhcp',
    };
    if (ciuser)     cfg.ciuser     = ciuser;
    if (cipassword) cfg.cipassword = cipassword;
    if (sshkeys)    cfg.sshkeys    = sshkeys;
    if (template === 'ubuntu') { cfg.ciupgrade = 1; cfg.citype = 'nocloud'; }
    await put(`/nodes/${NODE}/qemu/${vmid}/config`, cfg);
    sse(65, 'Configurações aplicadas.');

    // 4 — apply cloud-init snippet (Ubuntu only): installs qemu-guest-agent and enables SSH password auth
    if (template === 'ubuntu') {
      sse(70, 'Aplicando snippet cloud-init...');
      try {
        const storages    = await get(`/nodes/${NODE}/storage`);
        const names       = storages.map(s => `${s.storage}(${s.content})`).join(', ');
        const snippetStor = storages.find(s => s.active && s.content && s.content.includes('snippets'));
        if (snippetStor) {
          await put(`/nodes/${NODE}/qemu/${vmid}/config`, {
            cicustom: `vendor=${snippetStor.storage}:snippets/proxmox-dashboard-user.yaml`,
          });
          sse(77, `Snippet aplicado via ${snippetStor.storage}. SSH e qemu-guest-agent configurados para o 1º boot.`);
        } else {
          sse(77, `Aviso: nenhum storage com snippets encontrado. Storages: ${names}`);
        }
      } catch (e) { sse(77, `Aviso: cicustom não aplicado — ${e.message}`); }
    }

    // 5 — start VM
    sse(84, 'Iniciando VM...');
    const startUpid = await post(`/nodes/${NODE}/qemu/${vmid}/status/start`);
    await waitTask(startUpid);
    sse(100, `VM "${name}" criada e iniciada com sucesso!`, { done: true, vmid });
    res.end();

  } catch (e) {
    sse(0, `Erro: ${e.message}`, { error: true });
    res.end();
  }
});

app.listen(PORT, () => console.log(`Proxmox API rodando na porta ${PORT}`));
