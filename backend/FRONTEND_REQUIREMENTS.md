# Frontend Requirements — Proxmox Dashboard

Documento de requisitos completo baseado na análise do backend para criação de um frontend responsivo.

---

## 1. Stack & Configuração

| Item | Detalhe |
|------|---------|
| Backend URL | `http://localhost:3001` |
| Protocolo API | REST + Server-Sent Events (SSE) |
| Formato | JSON |
| CORS | Habilitado (qualquer origem aceita) |
| Cache | Desabilitado para rotas `/api/*` |

---

## 2. Autenticação

> **Não há autenticação no backend.** Todos os endpoints são públicos.
> O frontend pode exibir uma tela de login **falsa** (por UX) ou ir direto para o dashboard.

---

## 3. Páginas / Seções

### 3.1 Dashboard (Visão Geral)

**Fonte de dados:** `GET /api/node/status` + `GET /api/vms`

**Elementos obrigatórios:**
- Status do nó Proxmox (CPU, memória, uptime)
- Lista de storages com uso (usado/total)
- Contadores rápidos: total de VMs, rodando, paradas
- Botão de refresh manual
- Polling automático recomendado: 30s

**Resposta de `/api/node/status`:**
```json
{
  "status": { /* dados do nó */ },
  "storage": [ /* lista de storages */ ]
}
```

**Resposta de `/api/vms`:**
```json
[
  {
    "vmid": 100,
    "name": "vm-ubuntu",
    "status": "running",
    "uptime": 3600,
    "cores": 2,
    "memory": 2048,
    "maxmem": 4096,
    "template": 0
  }
]
```

---

### 3.2 Lista de VMs

**Fonte de dados:** `GET /api/vms`

**Elementos obrigatórios:**
- Tabela ou grid com cards de VMs
- Colunas: VMID, Nome, Status (badge colorido), CPU, RAM, Uptime
- Filtro/busca por nome ou VMID
- Badge de status: `running` → verde, `stopped` → cinza/vermelho
- Ações rápidas por VM (botões inline):
  - Start / Stop / Shutdown / Reboot
  - Ver detalhes
  - Abrir console VNC
  - Excluir
- Ordenação padrão por VMID (já ordenado pelo backend)
- Separação visual entre VMs normais e **templates** (`template === 1`)

---

### 3.3 Detalhes de VM

**Fonte de dados:** `GET /api/vms/:id/config`

**Resposta:**
```json
{
  "current": { "status": "running", "uptime": 3600, ... },
  "config":  { "cores": 2, "memory": 2048, "name": "...", ... }
}
```

**Elementos obrigatórios:**
- Status atual (rodando/parada, uptime)
- Configuração atual (cores, memória, nome, descrição)
- **Formulário de edição inline** para campos editáveis:
  - `cores` (número)
  - `memory` (número em MB)
  - `name` (texto)
  - `description` (textarea)
  - `balloon` (número — balloon driver de memória)
- Botão salvar → `PUT /api/vms/:id/config`
- **Formulário de resize de disco:**
  - Campo `disk` (ex: `scsi0`)
  - Campo `size` (ex: `+10G`)
  - Botão → `POST /api/vms/:id/resize`
- Botão "Abrir Console VNC" → abre nova aba com URL de `GET /api/vms/:id/console-url`
- Aba de histórico de tarefas → `GET /api/vms/:id/tasks`

**Corpo de `PUT /api/vms/:id/config`:**
```json
{
  "cores": 2,
  "memory": 2048,
  "name": "novo-nome",
  "description": "descrição",
  "balloon": 512
}
```

**Corpo de `POST /api/vms/:id/resize`:**
```json
{ "disk": "scsi0", "size": "+10G" }
```

---

### 3.4 Criar VM (Wizard / Multi-step)

**Endpoint:** `POST /api/vms/create` — responde com **Server-Sent Events (SSE)**

**Campos do formulário:**

| Campo | Tipo | Obrigatório | Observação |
|-------|------|------------|------------|
| `vmid` | número | Sim | ID único da VM |
| `name` | texto | Sim | Nome da VM |
| `template` | select | Sim | `ubuntu` ou `windows` |
| `cores` | número | Sim | Núcleos de CPU |
| `memory` | número | Sim | RAM em MB |
| `diskSize` | número | Sim | Tamanho do disco em GB |
| `storage` | texto | Não | Default: `local-lvm` |
| `ciuser` | texto | Não | Apenas Ubuntu (cloud-init) |
| `cipassword` | senha | Não | Apenas Ubuntu |
| `sshkeys` | textarea | Não | Apenas Ubuntu |
| `ipconfig` | texto | Não | Ex: `ip=192.168.1.10/24` |
| `gateway` | texto | Não | Ex: `192.168.1.1` |

**Fluxo SSE (Server-Sent Events):**

O frontend deve abrir uma conexão SSE ao submeter o formulário e exibir uma barra de progresso.

```javascript
// Exemplo de conexão SSE com fetch
const response = await fetch('/api/vms/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(formData)
});

const reader = response.body.getReader();
// Ler stream linha a linha e parsear eventos
```

**Formato de cada evento SSE:**
```json
{ "pct": 30, "msg": "Clone concluído", "done": false }
{ "pct": 100, "msg": "VM criada com sucesso", "done": true, "vmid": 105 }
{ "pct": 0, "msg": "Erro ao clonar template", "error": true }
```

**Estágios de progresso para a UI:**

| % | Mensagem esperada |
|---|-------------------|
| 5% | Iniciando clone do template |
| 30% | Clone concluído |
| 38–46% | Redimensionando disco |
| 52–65% | Configurando Cloud-Init, CPU, RAM, rede |
| 70–77% | Aplicando snippets (Ubuntu) |
| 84–100% | Iniciando VM / Concluído |

**Comportamento esperado do componente de progresso:**
- Barra de progresso animada (0–100%)
- Log de mensagens em tempo real (lista rolável)
- Estado de erro com mensagem destacada em vermelho
- Ao concluir (`done: true`): redirecionar para detalhes da VM (`vmid` fornecido)

---

### 3.5 Console VNC

**Endpoint:** `GET /api/vms/:id/console-url`

**Resposta:**
```json
{ "url": "https://192.168.3.100:8006/?console=kvm&vmid=100&..." }
```

- Abrir URL em nova aba (`window.open`)
- Botão visível apenas se VM estiver `running`

---

### 3.6 Backups

#### 3.6.1 Backups Manuais por VM

**Endpoints:**
- `GET /api/vms/:id/backups` — lista backups da VM
- `POST /api/vms/:id/backup` — criar backup
- `POST /api/backups/restore` — restaurar backup
- `DELETE /api/backups` — excluir backup

**Lista de backups:**
```json
[
  {
    "volid": "local:backup/vzdump-qemu-100-...",
    "ctime": 1716000000,
    "storage": "local",
    "size": 1073741824,
    "format": "vma.zst"
  }
]
```

**Criar backup — corpo da requisição:**
```json
{
  "storage": "local",
  "mode": "snapshot",
  "compress": "zstd",
  "notes": "Backup antes da atualização"
}
```

**Restaurar backup — corpo da requisição:**
```json
{
  "volid": "local:backup/vzdump-qemu-100-...",
  "vmid": 100,
  "storage": "local-lvm",
  "start": true
}
```

**Excluir backup — corpo da requisição:**
```json
{
  "volid": "local:backup/vzdump-qemu-100-...",
  "storage": "local"
}
```

**Elementos da UI:**
- Tabela de backups com: data/hora, tamanho, formato, storage
- Botão "Criar Backup" com modal de confirmação e opções
- Botão "Restaurar" por item (com modal de confirmação)
- Botão "Excluir" por item (com confirmação)
- Feedback de operação via monitoramento de task (UPID retornado)

#### 3.6.2 Backup Jobs (Agendados)

**Endpoints:**
- `GET /api/backup-jobs` — listar jobs
- `POST /api/backup-jobs` — criar job
- `GET /api/backup-jobs/:id` — detalhes do job
- `PUT /api/backup-jobs/:id` — atualizar job
- `DELETE /api/backup-jobs/:id` — excluir job

**Campos do formulário de criação/edição:**

| Campo | Tipo | Obrigatório | Observação |
|-------|------|------------|------------|
| `storage` | select | Sim | Storage de destino |
| `schedule` | texto | Sim | Cron expression (ex: `0 2 * * *`) |
| `vmid` | texto | Não | IDs separados por vírgula ou vazio = todos |
| `mode` | select | Não | `snapshot`, `suspend`, `stop` |
| `compress` | select | Não | `zstd`, `gzip`, `lzo`, `0` |
| `enabled` | boolean | Não | Default: habilitado |
| `comment` | texto | Não | Descrição do job |
| `keep-last` | número | Não | Retenção por quantidade |
| `keep-hourly` | número | Não | Retenção por hora |
| `keep-daily` | número | Não | Retenção diária |
| `keep-weekly` | número | Não | Retenção semanal |
| `keep-monthly` | número | Não | Retenção mensal |
| `keep-yearly` | número | Não | Retenção anual |

---

### 3.7 Tarefas (Tasks)

#### Histórico de Tarefas da VM

**Endpoint:** `GET /api/vms/:id/tasks`

**Resposta (limite 50):**
```json
[
  {
    "upid": "UPID:pve01:00001234:...",
    "type": "qmstart",
    "status": "stopped",
    "exitstatus": "OK",
    "user": "root@pam",
    "starttime": 1716000000,
    "node": "pve01"
  }
]
```

#### Log de Tarefa

**Endpoint:** `GET /api/tasks/:upid/log`

> O `:upid` deve ser URL-encoded antes de enviar.

**Resposta:**
```json
[
  { "n": 1, "t": "INFO: starting" },
  { "n": 2, "t": "INFO: done" }
]
```

#### Status de Tarefa

**Endpoint:** `GET /api/tasks/:upid/status`

```json
{
  "upid": "...",
  "status": "stopped",
  "exitstatus": "OK",
  "pid": 1234,
  "type": "qmstart",
  "starttime": 1716000000
}
```

**Elementos da UI:**
- Lista de tarefas com: tipo, status (badge), usuário, data/hora
- Badge: `OK` → verde, erro → vermelho, `running` → amarelo/animado
- Clique na task → abre modal/drawer com log completo
- Polling de status para tasks em execução (`status === "running"`)

---

### 3.8 Storage

**Endpoint:** `GET /api/storage`

**Resposta:**
```json
[
  {
    "storage": "local",
    "type": "dir",
    "active": true,
    "enabled": true,
    "content": "images,rootdir,backup",
    "nodes": "pve01"
  }
]
```

**Uso:** Popula selects de storage nos formulários de criação de VM, backup e restauração.

---

### 3.9 Templates

**Endpoint:** `GET /api/templates`

**Resposta:** Array de VMs com `template === 1`

**Uso:** Pode ser exibido como seção separada na lista de VMs ou usado internamente.

---

## 4. Controles de VM — Especificações de Ações

| Ação | Endpoint | Método | Condição |
|------|----------|--------|----------|
| Iniciar | `/api/vms/:id/start` | POST | Apenas se `stopped` |
| Parar (forçar) | `/api/vms/:id/stop` | POST | Apenas se `running` |
| Desligar (gracioso) | `/api/vms/:id/shutdown` | POST | Apenas se `running` |
| Reiniciar | `/api/vms/:id/reboot` | POST | Apenas se `running` |
| Excluir | `/api/vms/:id` | DELETE | Confirmar antes; se `running`, perguntar se usa `?force=true` |

**Excluir VM:**
- `DELETE /api/vms/:id` — excluir VM parada
- `DELETE /api/vms/:id?force=true` — para e exclui VM em execução
- **Retorna 409** se VM estiver rodando e `force` não for passado

---

## 5. Tratamento de Erros

**Formato de erro padrão:**
```json
{ "error": "mensagem de erro" }
```

**Códigos HTTP:**

| Código | Significado | Ação no Frontend |
|--------|-------------|-----------------|
| 200 | Sucesso | Processar resposta |
| 400 | Parâmetros inválidos | Exibir mensagem de validação |
| 409 | Conflito (ex: VM rodando) | Perguntar ao usuário (force?) |
| 500 | Erro interno / Proxmox | Toast de erro genérico |

---

## 6. Monitoramento de UPID (Tasks assíncronas)

Diversas operações retornam um `{ upid: "..." }` em vez do resultado final.
O frontend deve implementar **polling de status**:

```
1. Operação → retorna { upid }
2. GET /api/tasks/:upid/status  (poll a cada 2s)
3. Enquanto status === "running" → mostrar spinner/progresso
4. Quando status === "stopped":
   - exitstatus === "OK" → sucesso
   - exitstatus !== "OK" → exibir erro
5. GET /api/tasks/:upid/log → exibir log detalhado se necessário
```

**Operações que retornam UPID:**
- Criar backup (`POST /api/vms/:id/backup`)
- Restaurar backup (`POST /api/backups/restore`)

---

## 7. Formatação de Dados

| Dado | Formato de exibição |
|------|---------------------|
| Memória (bytes) | Converter para GB/MB/KB dinâmico |
| Memória (config) | Valor em MB → exibir em GB se ≥ 1024 |
| Uptime (segundos) | `Xd Xh Xm Xs` |
| Timestamp (unix) | Data/hora local formatada |
| Tamanho de backup (bytes) | Converter para unidade legível |
| VMID | Exibir como número inteiro |

---

## 8. Responsividade

| Breakpoint | Comportamento sugerido |
|------------|----------------------|
| Mobile (< 768px) | Cards em coluna única, menu colapsável (hamburger) |
| Tablet (768–1024px) | Grid 2 colunas, sidebar colapsável |
| Desktop (> 1024px) | Sidebar fixa, tabelas completas, grid 3–4 colunas |

---

## 9. Componentes Reutilizáveis Necessários

| Componente | Usado em |
|-----------|---------|
| `VMStatusBadge` | Lista de VMs, detalhes, tarefas |
| `TaskBadge` | Histórico de tarefas |
| `ProgressBar` | Criação de VM (SSE) |
| `SSELogViewer` | Criação de VM (SSE) |
| `ConfirmModal` | Delete VM, delete backup, forçar parada |
| `TaskLogModal` | Histórico de tarefas |
| `StorageSelect` | Formulários de backup, criação de VM |
| `UPIDPoller` | Monitoramento de tasks assíncronas |
| `ByteFormatter` | Exibição de tamanhos |
| `UptimeFormatter` | Uptime de VMs |
| `ToastNotification` | Feedback de erros e sucesso |

---

## 10. Fluxos Críticos

### Criação de VM
```
Formulário → POST /api/vms/create → SSE stream
→ Barra de progresso em tempo real
→ Ao concluir: redirecionar para /vms/:vmid
→ Em erro: exibir mensagem, limpar formulário
```

### Exclusão de VM
```
Botão delete → Verificar status
→ Se stopped: confirmar → DELETE /api/vms/:id
→ Se running: perguntar "Forçar parada e excluir?"
  → Sim: DELETE /api/vms/:id?force=true
→ Atualizar lista após sucesso
```

### Restaurar Backup
```
Selecionar backup → Modal com vmid + storage + opção start
→ POST /api/backups/restore → retorna { upid }
→ Polling de GET /api/tasks/:upid/status
→ Exibir progresso / log final
```

---

## 11. Health Check

**Endpoint:** `GET /api/health`

**Resposta:**
```json
{ "ok": true, "node": "pve01" }
```

**Uso sugerido:**
- Verificar conexão ao carregar o app
- Exibir banner de "servidor offline" se falhar
- Indicador de status no header/navbar
