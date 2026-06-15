const express   = require('express');
const https     = require('https');
const axios     = require('axios');
const cors      = require('cors');
const path      = require('path');
const Groq = require('groq-sdk');
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
  try {
    const vms = (await get(`/nodes/${NODE}/qemu`)).sort((a, b) => a.vmid - b.vmid);
    const running = vms.filter(v => v.status === 'running');
    if (running.length) {
      const statuses = await Promise.all(
        running.map(v => get(`/nodes/${NODE}/qemu/${v.vmid}/status/current`).catch(() => null))
      );
      statuses.forEach((s, i) => {
        if (!s) return;
        const vm = vms.find(v => v.vmid === running[i].vmid);
        if (vm) {
          // status/current reports actual guest memory usage via balloon driver
          vm.mem    = s.mem;
          vm.maxmem = s.maxmem;
          vm.cpu    = s.cpu;
          vm.cpus   = s.cpus;
        }
      });
    }
    res.json(vms);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// ── AI ASSISTANT (Groq) ──────────────────────────────────────────────────────
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 90000 })
  : null;

const AI_TOOLS_GROQ = [
  {
    type: 'function',
    function: {
      name: 'get_node_status',
      description: 'Obtém status do nó Proxmox: uso de CPU, memória, disco raiz e uptime.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vms',
      description: 'Lista todas as VMs com ID, nome, status, CPU, memória e uptime.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vm_config',
      description: 'Retorna configuração detalhada e status atual de uma VM específica.',
      parameters: {
        type: 'object',
        properties: { vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' } },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_vm',
      description: 'Inicia uma VM que está parada.',
      parameters: {
        type: 'object',
        properties: { vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' } },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_vm',
      description: 'Para forçadamente uma VM em execução (equivale a cortar energia).',
      parameters: {
        type: 'object',
        properties: { vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' } },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shutdown_vm',
      description: 'Desliga graciosamente uma VM via sinal ACPI de shutdown.',
      parameters: {
        type: 'object',
        properties: { vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' } },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reboot_vm',
      description: 'Reinicia uma VM em execução.',
      parameters: {
        type: 'object',
        properties: { vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' } },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_storage',
      description: 'Lista todos os storages com capacidade total e uso atual.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vm_backups',
      description: 'Lista backups disponíveis de uma VM específica.',
      parameters: {
        type: 'object',
        properties: { vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' } },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vm_tasks',
      description: 'Lista o histórico de tarefas e operações realizadas em uma VM: inicializações, paradas, backups, migrações, criações, etc. Use para gerar logs de operações de uma VM.',
      parameters: {
        type: 'object',
        properties: { vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' } },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_vm_config',
      description: 'Atualiza configurações de uma VM: número de vCPUs, memória RAM, nome ou descrição. A VM não precisa estar parada para alterações de nome/descrição, mas CPU e RAM exigem reboot para ter efeito.',
      parameters: {
        type: 'object',
        properties: {
          vmid:        { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' },
          cores:       { type: 'number', description: 'Número de vCPUs' },
          memory:      { type: 'number', description: 'Memória RAM em MB (ex: 4096 = 4 GB)' },
          name:        { type: 'string', description: 'Novo nome da VM' },
          description: { type: 'string', description: 'Descrição/anotação da VM' },
        },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resize_vm_disk',
      description: 'Aumenta o tamanho do disco de uma VM. Use +10G para adicionar 10 GB ao tamanho atual, ou 50G para definir o tamanho total. Só é possível aumentar, nunca diminuir.',
      parameters: {
        type: 'object',
        properties: {
          vmid: { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' },
          size: { type: 'string', description: 'Incremento ex: +10G, ou tamanho total ex: 50G' },
          disk: { type: 'string', description: 'Disco alvo (padrão: scsi0)' },
        },
        required: ['vmid', 'size'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_vm',
      description: 'Exclui permanentemente uma VM e todos os seus discos. Ação irreversível — só execute quando o usuário confirmar explicitamente.',
      parameters: {
        type: 'object',
        properties: {
          vmid:  { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' },
          force: { type: 'boolean', description: 'Forçar exclusão mesmo se a VM estiver rodando (padrão: false)' },
        },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'backup_vm',
      description: 'Inicia um backup de uma VM e aguarda a conclusão. Retorna resultado do backup.',
      parameters: {
        type: 'object',
        properties: {
          vmid:     { type: 'string', description: 'ID numérico ou nome da VM (ex: 101 ou "ubuntu-server")' },
          storage:  { type: 'string', description: 'Storage de destino (padrão: local)' },
          mode:     { type: 'string', description: 'Modo: snapshot, suspend ou stop (padrão: snapshot)' },
          compress: { type: 'string', description: 'Compressão: zstd, lzo, gzip (padrão: zstd)' },
        },
        required: ['vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restore_vm_backup',
      description: 'Restaura uma VM a partir de um backup. Use get_vm_backups para obter o volid do backup.',
      parameters: {
        type: 'object',
        properties: {
          volid:   { type: 'string', description: 'Volume ID do backup (ex: local:backup/vzdump-qemu-101-...)' },
          vmid:    { type: 'number', description: 'ID que a VM restaurada receberá' },
          storage: { type: 'string', description: 'Storage de destino para os discos (padrão: local-lvm)' },
          start:   { type: 'boolean', description: 'Iniciar VM automaticamente após restaurar' },
        },
        required: ['volid', 'vmid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_backup',
      description: 'Exclui permanentemente um arquivo de backup do storage. Ação irreversível.',
      parameters: {
        type: 'object',
        properties: {
          volid:   { type: 'string', description: 'Volume ID do backup' },
          storage: { type: 'string', description: 'Nome do storage onde o backup está' },
        },
        required: ['volid', 'storage'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_linux_vm',
      description: 'Cria uma nova VM Linux Ubuntu clonando o template padrão, configurando CPU, RAM, disco e cloud-init, e inicia a VM automaticamente. Use quando o usuário pedir para criar uma VM Linux.',
      parameters: {
        type: 'object',
        properties: {
          name:       { type: 'string', description: 'Nome da VM (obrigatório)' },
          cores:      { type: 'number', description: 'Número de vCPUs (padrão: 2)' },
          memory_mb:  { type: 'number', description: 'Memória RAM em MB (padrão: 2048)' },
          disk_gb:    { type: 'number', description: 'Tamanho do disco em GB (padrão: 20)' },
          ciuser:     { type: 'string', description: 'Usuário cloud-init (padrão: ubuntu)' },
          cipassword: { type: 'string', description: 'Senha do usuário cloud-init' },
          ip:         { type: 'string', description: 'IP estático no formato 192.168.1.100/24 — omitir para DHCP' },
          gateway:    { type: 'string', description: 'Gateway padrão, necessário se ip for fornecido' },
        },
        required: ['name'],
      },
    },
  },
];

const AI_TOOL_LABELS = {
  get_node_status: 'Verificando status do nó...',
  get_vms:         'Listando VMs...',
  get_vm_config:   'Carregando config da VM...',
  start_vm:        'Iniciando VM...',
  stop_vm:         'Parando VM...',
  shutdown_vm:     'Desligando VM...',
  reboot_vm:       'Reiniciando VM...',
  get_storage:     'Consultando storage...',
  get_vm_backups:  'Listando backups...',
  get_vm_tasks:       'Buscando histórico de operações...',
  update_vm_config:   'Atualizando configuração da VM...',
  resize_vm_disk:     'Redimensionando disco...',
  delete_vm:          'Excluindo VM...',
  backup_vm:          'Executando backup...',
  restore_vm_backup:  'Restaurando backup...',
  delete_backup:      'Excluindo backup...',
  create_linux_vm:    'Criando VM Linux...',
};

async function resolveVmid(input) {
  const val = input.vmid;
  if (val === undefined || val === null) throw new Error('vmid é obrigatório');
  const num = parseInt(val);
  if (!isNaN(num) && String(num) === String(val).trim()) return num;
  const vms = await get(`/nodes/${NODE}/qemu`);
  const vm = vms.find(v => v.name && v.name.toLowerCase() === String(val).toLowerCase());
  if (!vm) throw new Error(`VM "${val}" não encontrada. Use get_vms para listar as VMs disponíveis.`);
  return vm.vmid;
}

async function executeAITool(name, input) {
  try {
    switch (name) {
      case 'get_node_status': {
        const [status, storage] = await Promise.all([
          get(`/nodes/${NODE}/status`),
          get(`/nodes/${NODE}/storage`),
        ]);
        return { status, storage };
      }
      case 'get_vms':
        return (await get(`/nodes/${NODE}/qemu`)).sort((a, b) => a.vmid - b.vmid);
      case 'get_vm_config': {
        const vmid = await resolveVmid(input);
        const [current, config] = await Promise.all([
          get(`/nodes/${NODE}/qemu/${vmid}/status/current`),
          get(`/nodes/${NODE}/qemu/${vmid}/config`),
        ]);
        return { current, config };
      }
      case 'start_vm': {
        const vmid = await resolveVmid(input);
        return { upid: await post(`/nodes/${NODE}/qemu/${vmid}/status/start`) };
      }
      case 'stop_vm': {
        const vmid = await resolveVmid(input);
        return { upid: await post(`/nodes/${NODE}/qemu/${vmid}/status/stop`) };
      }
      case 'shutdown_vm': {
        const vmid = await resolveVmid(input);
        return { upid: await post(`/nodes/${NODE}/qemu/${vmid}/status/shutdown`) };
      }
      case 'reboot_vm': {
        const vmid = await resolveVmid(input);
        return { upid: await post(`/nodes/${NODE}/qemu/${vmid}/status/reboot`) };
      }
      case 'get_storage':
        return await get(`/nodes/${NODE}/storage`);
      case 'get_vm_backups': {
        const vmid = await resolveVmid(input);
        const storages = await get(`/nodes/${NODE}/storage`);
        const bkpStors = storages.filter(s => s.active && s.content && s.content.includes('backup'));
        const results = [];
        for (const stor of bkpStors) {
          try {
            const content = await get(`/nodes/${NODE}/storage/${stor.storage}/content?content=backup&vmid=${vmid}`);
            results.push(...content.map(b => ({ ...b, storage: stor.storage })));
          } catch (_) {}
        }
        return results.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
      }
      case 'get_vm_tasks': {
        const vmid = await resolveVmid(input);
        return await get(`/nodes/${NODE}/tasks?vmid=${vmid}&limit=50`);
      }
      case 'update_vm_config': {
        const vmid = await resolveVmid(input);
        const body = {};
        if (input.cores       !== undefined) body.cores       = parseInt(input.cores);
        if (input.memory      !== undefined) body.memory      = parseInt(input.memory);
        if (input.name        !== undefined) body.name        = input.name;
        if (input.description !== undefined) body.description = input.description;
        await put(`/nodes/${NODE}/qemu/${vmid}/config`, body);
        return { success: true, vmid, updated: body };
      }
      case 'resize_vm_disk': {
        const vmid = await resolveVmid(input);
        const disk = input.disk || 'scsi0';
        await put(`/nodes/${NODE}/qemu/${vmid}/resize`, { disk, size: input.size });
        return { success: true, vmid, disk, size: input.size };
      }
      case 'delete_vm': {
        const vmid = await resolveVmid(input);
        const current = await get(`/nodes/${NODE}/qemu/${vmid}/status/current`);
        if (current.status === 'running') {
          if (!input.force) return { error: 'VM está rodando. Peça confirmação ao usuário e use force: true para forçar, ou desligue a VM primeiro.' };
          const stopUpid = await post(`/nodes/${NODE}/qemu/${vmid}/status/stop`);
          await waitTask(stopUpid);
        }
        const delUpid = await del(`/nodes/${NODE}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`);
        await waitTask(delUpid);
        return { success: true, vmid };
      }
      case 'backup_vm': {
        const vmid = await resolveVmid(input);
        const upid = await post(`/nodes/${NODE}/vzdump`, {
          vmid,
          storage:  input.storage  || 'local',
          mode:     input.mode     || 'snapshot',
          compress: input.compress || 'zstd',
        });
        await waitTask(upid, 600000);
        return { success: true, vmid, upid };
      }
      case 'restore_vm_backup': {
        const upid = await post(`/nodes/${NODE}/qemu`, {
          archive: input.volid,
          vmid:    parseInt(input.vmid),
          storage: input.storage || 'local-lvm',
          start:   input.start ? 1 : 0,
          unique:  1,
        });
        await waitTask(upid, 600000);
        return { success: true, vmid: input.vmid, upid };
      }
      case 'delete_backup': {
        const enc = encodeURIComponent(input.volid);
        await del(`/nodes/${NODE}/storage/${input.storage}/content/${enc}`);
        return { success: true, volid: input.volid };
      }
      case 'create_linux_vm': {
        const UTPL   = parseInt(process.env.UBUNTU_TEMPLATE_ID || '9000');
        const stor   = 'local-lvm';
        const vmid   = await get('/cluster/nextid');
        const name   = input.name;
        const cores  = parseInt(input.cores)     || 2;
        const memory = parseInt(input.memory_mb) || 2048;
        const diskGb = parseInt(input.disk_gb)   || 20;

        const cloneUpid = await post(`/nodes/${NODE}/qemu/${UTPL}/clone`, {
          newid: parseInt(vmid), name, full: 1, storage: stor,
        });
        await waitTask(cloneUpid, 300000);

        try {
          await put(`/nodes/${NODE}/qemu/${vmid}/resize`, { disk: 'scsi0', size: `${diskGb}G` });
        } catch (_) {}

        const cfg = {
          cores, memory, agent: 'enabled=1', ciupgrade: 1, citype: 'nocloud',
          ipconfig0: (input.ip && input.gateway) ? `ip=${input.ip},gw=${input.gateway}` : 'ip=dhcp',
        };
        if (input.ciuser)     cfg.ciuser     = input.ciuser;
        if (input.cipassword) cfg.cipassword = input.cipassword;
        await put(`/nodes/${NODE}/qemu/${vmid}/config`, cfg);

        try {
          const storages    = await get(`/nodes/${NODE}/storage`);
          const snippetStor = storages.find(s => s.active && s.content && s.content.includes('snippets'));
          if (snippetStor) {
            await put(`/nodes/${NODE}/qemu/${vmid}/config`, {
              cicustom: `vendor=${snippetStor.storage}:snippets/proxmox-dashboard-user.yaml`,
            });
          }
        } catch (_) {}

        const startUpid = await post(`/nodes/${NODE}/qemu/${vmid}/status/start`);
        await waitTask(startUpid, 120000);

        return {
          success:   true,
          vmid:      parseInt(vmid),
          name,
          cores,
          memory_mb: memory,
          disk_gb:   diskGb,
          network:   (input.ip && input.gateway) ? `${input.ip} via ${input.gateway}` : 'DHCP',
        };
      }
      default:
        return { error: 'Ferramenta desconhecida: ' + name };
    }
  } catch (e) {
    return { error: e.message };
  }
}

const AI_SYSTEM = `Você é um assistente de infraestrutura integrado a um dashboard Proxmox VE. Você pode executar todas as operações de gerenciamento de VMs diretamente.
Responda sempre em português, de forma direta e técnica.

Capacidades disponíveis:
- Consultar: status do nó, lista de VMs, configuração de VM, storage, backups, histórico de tarefas
- Controlar VMs: iniciar, parar (force stop), desligar (graceful), reiniciar
- Reconfigurar VMs: alterar CPU, RAM, nome, descrição (update_vm_config)
- Disco: aumentar tamanho de disco (resize_vm_disk)
- Criar VM Linux: clone do template Ubuntu com cloud-init (create_linux_vm) — use defaults 2 vCPU / 2048 MB / 20 GB / DHCP se não especificado. ANTES de chamar create_linux_vm, sempre mostre uma tabela markdown com os dados que serão criados (incluindo as colunas: Nome, CPU, RAM, Disco, Rede, Usuário, Senha) e pergunte "Confirma a criação?" — só execute a tool após confirmação explícita do usuário.
- Backup: executar backup (backup_vm), restaurar (restore_vm_backup), excluir backup (delete_backup)

Para ações destrutivas irreversíveis (delete_vm, delete_backup, restore_vm_backup): mostre o que será feito e pergunte "Tem certeza?" antes de executar, se não houver confirmação explícita na mensagem.
Ao listar VMs, mostre nome, ID, status e métricas principais formatadas de forma legível.`;

app.post('/api/ai/chat', async (req, res) => {
  if (!groq) {
    return res.status(503).json({ error: 'GROQ_API_KEY não configurada no servidor.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sse = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const { messages } = req.body;

  if (!Array.isArray(messages) || !messages.length) {
    sse({ type: 'error', message: 'messages inválido' });
    return res.end();
  }

  const history = [
    { role: 'system', content: AI_SYSTEM },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    let loop = true;

    while (loop) {
      // Non-streaming for tool calls — Groq streaming + tools causes failed_generation errors
      const response = await groq.chat.completions.create({
        model:       'llama-3.3-70b-versatile',
        messages:    history,
        tools:       AI_TOOLS_GROQ,
        tool_choice: 'auto',
        max_tokens:  4096,
        stream:      false,
      });

      const message   = response.choices[0].message;
      const toolCalls = message.tool_calls || [];

      if (toolCalls.length > 0) {
        history.push(message);

        for (const tc of toolCalls) {
          sse({ type: 'tool_start', name: tc.function.name, label: AI_TOOL_LABELS[tc.function.name] || tc.function.name });
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
          const result = await executeAITool(tc.function.name, args);
          sse({ type: 'tool_end', name: tc.function.name });
          history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      } else {
        const content = message.content || '';
        if (content) sse({ type: 'text', delta: content });
        loop = false;
      }
    }

    sse({ type: 'done', history: messages });
    res.end();
  } catch (e) {
    sse({ type: 'error', message: e.message });
    res.end();
  }
});

// ── OS LOGS via QEMU Guest Agent ──────────────────────────────────────────────
app.get('/api/vms/:id/os-logs', async (req, res) => {
  try {
    const vmid = req.params.id;
    const [current, config] = await Promise.all([
      get(`/nodes/${NODE}/qemu/${vmid}/status/current`),
      get(`/nodes/${NODE}/qemu/${vmid}/config`),
    ]);

    if (current.status !== 'running') {
      return res.status(409).json({ error: 'VM não está em execução. Inicie a VM para capturar logs do SO.' });
    }

    const ostype = config.ostype || '';
    const isWindows = ostype.startsWith('w');

    const cmd = isWindows
      ? ['powershell.exe', '-NonInteractive', '-Command',
          'Get-WinEvent -FilterHashtable @{LogName="System","Application";Level=1,2,3} -MaxEvents 200 -ErrorAction SilentlyContinue' +
          ' | Sort-Object TimeCreated -Descending' +
          ' | ForEach-Object { $_.TimeCreated.ToString("yyyy-MM-dd HH:mm:ss") + " [" + $_.LevelDisplayName.ToUpper() + "] " + $_.ProviderName + ": " + (($_.Message -split "`n")[0]) }']
      : ['/bin/bash', '-c',
          'journalctl -p 0..4 --no-pager -n 300 -o short-iso --no-hostname 2>/dev/null' +
          ' || grep -Ei "(error|crit|emerg|alert|warn|fail)" /var/log/syslog 2>/dev/null | tail -n 300' +
          ' || grep -Ei "(error|crit|emerg|alert|warn|fail)" /var/log/messages 2>/dev/null | tail -n 300'];

    let execRes;
    try {
      execRes = await post(`/nodes/${NODE}/qemu/${vmid}/agent/exec`, { command: cmd });
    } catch (e) {
      const raw = e.response?.data?.errors ? JSON.stringify(e.response.data.errors) : e.message;
      const lo = raw.toLowerCase();
      if (lo.includes('agent') || lo.includes('not running') || lo.includes('enabled')) {
        return res.status(503).json({ error: 'QEMU Guest Agent não está disponível. Instale e inicie o qemu-guest-agent na VM e habilite o agent nas configurações da VM.' });
      }
      throw e;
    }

    const pid = execRes.pid;
    const t0 = Date.now();
    let result = null;
    while (Date.now() - t0 < 30000) {
      await sleep(1500);
      result = await get(`/nodes/${NODE}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
      if (result.exited) break;
    }

    if (!result?.exited) {
      return res.status(504).json({ error: 'Timeout: o comando demorou mais de 30s para responder na VM.' });
    }

    const output = (result['out-data'] || '').trim();
    const errOutput = (result['err-data'] || '').trim();

    if (!output && errOutput) {
      return res.status(500).json({ error: 'Erro no SO: ' + errOutput.slice(0, 400) });
    }

    const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0).map(l => ({ t: l }));
    res.json({ lines, ostype, isWindows, total: lines.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ai/analyze-log', async (req, res) => {
  if (!groq) {
    return res.status(503).json({ error: 'GROQ_API_KEY não configurada no servidor.' });
  }

  const { log, taskType, logSource } = req.body;
  if (!Array.isArray(log)) return res.status(400).json({ error: 'log é obrigatório' });

  const logText = log.map(l => l.t || l.text || JSON.stringify(l)).join('\n');
  const isOS = logSource === 'os';
  const maxChars = isOS ? 9000 : 6000;
  const trimmed = logText.length > maxChars ? logText.slice(-maxChars) : logText;

  const prompt = isOS
    ? `Você é especialista em administração de servidores Linux/Windows e segurança. Analise estes logs do sistema operacional capturados via QEMU Guest Agent e responda em português:\n1. Quais são os problemas mais críticos identificados?\n2. Há padrões preocupantes (serviços falhando, erros de autenticação, problemas de disco/memória/rede)?\n3. Quais ações corretivas você recomenda priorizar?\n\nFoque nos eventos mais relevantes. Seja direto e técnico, responda em até 4 parágrafos.\n\nLogs do SO:\n${trimmed}`
    : `Você é especialista em Proxmox VE. Analise este log de tarefa${taskType ? ' (' + taskType + ')' : ''} e responda em português:\n1. O que aconteceu (sucesso ou falha)?\n2. Se falhou, qual o motivo e como resolver?\n3. Alguma observação relevante?\n\nResponda de forma direta em até 3 parágrafos curtos.\n\nLog:\n${trimmed}`;

  try {
    const completion = await groq.chat.completions.create({
      model:      'llama-3.3-70b-versatile',
      max_tokens: isOS ? 1024 : 512,
      messages:   [{ role: 'user', content: prompt }],
    });
    res.json({ analysis: completion.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Proxmox API rodando na porta ${PORT}`));
