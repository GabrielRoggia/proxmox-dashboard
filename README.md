# Proxmox Dashboard com Assistente IA

Dashboard web para gerenciamento de infraestrutura Proxmox VE com assistente de Inteligência Artificial integrado, capaz de executar operações em linguagem natural.

---

## Sumário

1. [Descrição do Sistema](#1-descrição-do-sistema)
2. [Arquitetura](#2-arquitetura)
3. [Tecnologias Utilizadas](#3-tecnologias-utilizadas)
4. [Inteligência Artificial](#4-inteligência-artificial)
5. [Funcionalidades](#5-funcionalidades)
6. [Instruções de Uso](#6-instruções-de-uso)
7. [Como Reproduzir o Ambiente](#7-como-reproduzir-o-ambiente)
8. [Variáveis de Ambiente](#8-variáveis-de-ambiente)
9. [Evoluções e Melhorias Futuras](#9-evoluções-e-melhorias-futuras)
10. [Modelo de Negócio](#10-modelo-de-negócio)

---

## 1. Descrição do Sistema

O **Proxmox Dashboard** resolve um problema real de administração de servidores: gerenciar uma plataforma de virtualização (Proxmox VE) normalmente exige conhecimento técnico aprofundado da interface nativa, que é complexa e pouco intuitiva. Este sistema oferece:

- Uma **interface web moderna** que simplifica as operações mais comuns de gerenciamento de VMs
- Um **assistente de IA conversacional** que permite executar qualquer operação — desde listar VMs até criar, configurar, fazer backup e deletar máquinas — usando linguagem natural em português
- **Análise inteligente de logs** de tarefas, onde a IA explica o que aconteceu e como resolver problemas

O usuário acessa o dashboard pelo navegador, conecta ao backend (que fica na mesma rede do servidor Proxmox) e pode interagir com toda a infraestrutura tanto pela interface gráfica quanto conversando com o assistente.

---

## 2. Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                        USUÁRIO                              │
│                    (Navegador Web)                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP / SSE
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   BACKEND (Node.js)                         │
│                                                             │
│  ┌─────────────────┐     ┌──────────────────────────────┐  │
│  │   REST API      │     │      AI Layer                │  │
│  │   Express.js    │     │   Groq SDK (LLaMA 3.3-70b)  │  │
│  │                 │     │                              │  │
│  │  /api/vms       │     │  /api/ai/chat      ──────►  │  │
│  │  /api/backups   │     │  /api/ai/analyze-log  ────► │  │
│  │  /api/storage   │     │                              │  │
│  └────────┬────────┘     └──────────────────────────────┘  │
│           │                                                 │
└───────────┼─────────────────────────────────────────────────┘
            │ HTTPS + Token Auth
            ▼
┌─────────────────────────────────────────────────────────────┐
│              PROXMOX VE (Servidor de Virtualização)         │
│                   API REST  /api2/json                      │
│                                                             │
│     ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                │
│     │ VM 1 │  │ VM 2 │  │ VM 3 │  │ VM N │                │
│     └──────┘  └──────┘  └──────┘  └──────┘                │
└─────────────────────────────────────────────────────────────┘

                                        ┌──────────────────┐
                                        │    Groq Cloud    │
                                        │  LLaMA 3.3-70b   │
                                        │  (Function Call) │
                                        └──────────────────┘
```

### Fluxo de uma requisição comum

1. O frontend (HTML/JS estático) é servido pelo próprio backend Express
2. O usuário interage com a UI ou o chat de IA
3. O backend recebe a requisição, processa e repassa à API do Proxmox via HTTPS
4. Para requisições de IA, o backend envia o histórico de mensagens ao Groq (LLaMA 3.3-70b), que decide quais ferramentas executar
5. O backend executa as ferramentas na API do Proxmox e retorna os resultados ao modelo
6. A resposta final é enviada ao frontend via **Server-Sent Events (SSE)** para streaming em tempo real

---

## 3. Tecnologias Utilizadas

### Backend

| Tecnologia | Versão | Função |
|---|---|---|
| **Node.js** | 18+ | Runtime do servidor |
| **Express.js** | 4.19 | Framework HTTP / roteamento |
| **Groq SDK** | 1.2 | Integração com a API do Groq (LLM) |
| **Axios** | 1.7 | Cliente HTTP para comunicação com Proxmox |
| **dotenv** | 16.4 | Gerenciamento de variáveis de ambiente |
| **SSE (Server-Sent Events)** | nativo | Streaming de respostas em tempo real |

### Frontend

| Tecnologia | Função |
|---|---|
| **HTML5 / CSS3 / JavaScript** | Interface sem frameworks — SPA single-file |
| **CSS Custom Properties** | Sistema de design com glassmorphism |
| **Fetch API + SSE** | Comunicação com o backend |
| **SVG inline** | Ícones sem dependências externas |

### Infraestrutura / IA

| Serviço | Função |
|---|---|
| **Proxmox VE** | Plataforma de virtualização gerenciada |
| **Groq** | Provedor de inferência de LLM (ultra-baixa latência) |
| **LLaMA 3.3-70b-versatile** | Modelo de linguagem com suporte a function calling |

---

## 4. Inteligência Artificial

### Conceito aplicado

O sistema utiliza um **assistente autônomo com tomada de decisão** baseado em *function calling* (uso de ferramentas). O modelo de linguagem não apenas responde em texto — ele decide quais operações executar, em que ordem, e aguarda os resultados antes de formular a resposta ao usuário.

### Como funciona

```
Usuário: "Cria uma VM Ubuntu com 4 CPUs e 8 GB de RAM chamada web-server"

        ┌──────────────────────────────────────────────┐
        │           LLaMA 3.3-70b (Groq)              │
        │                                              │
        │  1. Analisa a mensagem                       │
        │  2. Decide chamar: create_linux_vm(          │
        │       name="web-server", cores=4,            │
        │       memory_mb=8192)                        │
        └──────────────────┬───────────────────────────┘
                           │ function call
                           ▼
        ┌──────────────────────────────────────────────┐
        │              Backend (Node.js)               │
        │                                              │
        │  Executa sequência automaticamente:          │
        │  ① GET /cluster/nextid → vmid=106            │
        │  ② POST clone template → aguarda task        │
        │  ③ PUT resize disk → 20GB                   │
        │  ④ PUT config → CPU, RAM, cloud-init         │
        │  ⑤ POST start → aguarda VM iniciar          │
        └──────────────────┬───────────────────────────┘
                           │ resultado JSON
                           ▼
        ┌──────────────────────────────────────────────┐
        │           LLaMA 3.3-70b (Groq)              │
        │                                              │
        │  "VM web-server criada com sucesso!          │
        │   ID: 106 | 4 vCPUs | 8 GB RAM | 20 GB      │
        │   A VM está rodando e pronta para uso."      │
        └──────────────────────────────────────────────┘
```

### Ferramentas disponíveis para o assistente

| Ferramenta | Descrição |
|---|---|
| `get_node_status` | CPU, memória, disco e uptime do servidor |
| `get_vms` | Lista todas as VMs com status e métricas |
| `get_vm_config` | Configuração detalhada de uma VM específica |
| `start_vm` | Inicia uma VM parada |
| `stop_vm` | Para forçadamente uma VM (corte de energia) |
| `shutdown_vm` | Desliga graciosamente via sinal ACPI |
| `reboot_vm` | Reinicia uma VM |
| `get_storage` | Lista storages com capacidade e uso |
| `get_vm_backups` | Lista backups de uma VM |
| `get_vm_tasks` | Histórico de operações de uma VM |
| `update_vm_config` | Altera CPU, RAM, nome ou descrição |
| `resize_vm_disk` | Aumenta disco (ex: `+10G` ou `50G`) |
| `delete_vm` | Exclui VM e todos os discos (irreversível) |
| `backup_vm` | Executa backup e aguarda conclusão |
| `restore_vm_backup` | Restaura VM a partir de backup |
| `delete_backup` | Exclui arquivo de backup do storage |
| `create_linux_vm` | Cria VM Ubuntu com cloud-init completo |

### Análise de Logs

Além do chat, o sistema oferece análise automática de logs de tarefas. Ao clicar em qualquer tarefa no histórico, o usuário pode pedir uma análise de IA que explica:
- Se a operação foi bem-sucedida ou falhou
- A causa raiz do problema (quando há falha)
- Como resolver o problema

### Segurança do Assistente

O assistente tem salvaguardas incorporadas no prompt de sistema:
- **Ações destrutivas** (deletar VM, deletar backup, restaurar) exigem confirmação explícita do usuário antes de executar
- **Criação de VM** sempre apresenta uma tabela com os parâmetros para confirmação prévia
- **Resolução por nome**: o usuário pode referenciar VMs pelo nome (ex: "a VM ubuntu-server") em vez do ID numérico

---

## 5. Funcionalidades

### Dashboard

- Métricas em tempo real do nó: CPU, memória, disco raiz, contagem de VMs
- Cards de VMs com gauges circulares de CPU e memória
- Histórico de sparklines de uso por VM
- Painel de ações recentes

### Gerenciamento de VMs

- Listagem completa com status, CPU, memória, disco e uptime
- Ações inline: iniciar, parar, desligar, reiniciar, abrir console VNC
- Edição de configuração (vCPUs, RAM, nome, descrição)
- Redimensionamento de disco
- Exclusão com confirmação e opção de força

### Criação de VMs

- Suporte a templates Ubuntu 24.04 e Windows Server 2025
- Configuração via sliders de CPU, RAM e disco
- Configuração cloud-init automática (usuário, senha, SSH key, IP estático ou DHCP)
- Log de progresso em tempo real via SSE

### Backups

- Backup manual por VM com escolha de storage e modo de compressão
- Restauração de backup com seleção de storage de destino
- Exclusão de backups individuais
- Agendamentos de backup recorrentes (cron) com políticas de retenção configuráveis

### Logs e Tarefas

- Histórico das últimas 50 tarefas por VM
- Visualização completa de log por tarefa
- **Análise de log por IA** com um clique

### Assistente IA

- Chat em linguagem natural com streaming de respostas
- Execução de operações reais na infraestrutura
- Sugestões de perguntas frequentes na tela inicial
- Chips animados mostrando quais ferramentas estão sendo executadas em tempo real

---

## 6. Instruções de Uso

### Pré-requisitos

- Servidor **Proxmox VE 7+** acessível na rede
- **API Token** do Proxmox criado com permissões de administrador
- Templates de VM configurados no Proxmox (Ubuntu e/ou Windows)
- **Node.js 18+** instalado na máquina que rodará o backend
- Conta e **API Key** no [Groq](https://console.groq.com) (gratuito)

### Acesso

1. Acesse a URL onde o sistema está publicado pelo navegador
2. Na tela inicial, informe a URL do backend (ex: `http://192.168.3.102:3001`)
3. Clique em **Conectar** — o sistema verifica a conexão via `/api/health`
4. Navegue pelas seções usando o menu lateral

### Usando o Assistente IA

1. Clique em **Assistente IA** no menu lateral
2. Digite uma pergunta ou comando em português natural
3. Exemplos de comandos:
   - `"Liste todas as VMs e me diga qual está usando mais memória"`
   - `"Crie uma VM Ubuntu chamada dev-server com 2 CPUs e 4 GB de RAM"`
   - `"Faça backup da VM 101 e me confirme quando terminar"`
   - `"Qual é o uso atual de CPU e memória do servidor?"`
   - `"Aumente o disco da VM web-server para 50 GB"`

---

## 7. Como Reproduzir o Ambiente

### 1. Clonar o repositório

```bash
git clone https://github.com/GabrielRoggia/proxmox-dashboard.git
cd proxmox-dashboard
```

### 2. Instalar dependências

```bash
cd backend
npm install
```

### 3. Configurar variáveis de ambiente

```bash
cp backend/.env.example backend/.env
```

Edite o arquivo `backend/.env` com os dados do seu ambiente (veja a seção [Variáveis de Ambiente](#8-variáveis-de-ambiente)).

### 4. Configurar o Proxmox VE

#### Criar API Token

No Proxmox, acesse **Datacenter → Permissions → API Tokens** e crie um token:

```
Usuário:  root@pam
Token ID: dashboard
Privilege Separation: desmarcado (para herdar permissões de root)
```

Anote o **Token Secret** gerado — ele só é exibido uma vez.

#### Configurar Templates de VM

Para a funcionalidade de criação de VM, o Proxmox precisa ter templates configurados. Exemplo para Ubuntu 24.04:

```bash
# No servidor Proxmox, como root:

# 1. Baixar a imagem cloud
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img \
  -O /var/lib/vz/template/iso/noble-server-cloudimg-amd64.img

# 2. Criar VM base (ID 9000)
qm create 9000 --name ubuntu-2404-template --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 --ostype l26

# 3. Importar disco
qm importdisk 9000 /var/lib/vz/template/iso/noble-server-cloudimg-amd64.img local-lvm

# 4. Configurar
qm set 9000 --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-9000-disk-0
qm set 9000 --boot c --bootdisk scsi0
qm set 9000 --ide2 local-lvm:cloudinit
qm set 9000 --serial0 socket --vga serial0
qm set 9000 --agent enabled=1

# 5. Converter para template
qm template 9000
```

#### Configurar Cloud-Init Snippet (opcional, mas recomendado)

Para que VMs Ubuntu criadas pelo dashboard tenham o `qemu-guest-agent` instalado automaticamente e SSH com senha habilitado:

```bash
# No servidor Proxmox:
mkdir -p /var/lib/vz/snippets

cat > /var/lib/vz/snippets/proxmox-dashboard-user.yaml << 'EOF'
#cloud-config
package_update: true
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable --now qemu-guest-agent
  - sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - systemctl restart sshd
EOF
```

Em seguida, no Proxmox, habilite o storage `local` para conteúdo do tipo `snippets`:
**Datacenter → Storage → local → Editar → Content → marcar "Snippets"**

### 5. Iniciar o servidor

```bash
# Desenvolvimento (com auto-reload)
cd backend
npm run dev

# Produção
cd backend
npm start
```

O backend estará disponível em `http://localhost:3001`.  
O frontend é servido automaticamente pelo mesmo processo na mesma porta.

### 6. Acessar o sistema

Abra o navegador em `http://localhost:3001` (ou o endereço/porta configurado).

---

## 8. Variáveis de Ambiente

Crie o arquivo `backend/.env` baseado no modelo abaixo:

```env
# URL do servidor Proxmox VE (com porta 8006)
PVE_HOST=https://192.168.1.100:8006

# Nome do nó Proxmox (padrão: pve)
PVE_NODE=pve

# Credenciais do API Token do Proxmox
# Formato: usuario@realm!tokenid
PVE_TOKEN_ID=root@pam!dashboard
PVE_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# IDs dos templates de VM no Proxmox
UBUNTU_TEMPLATE_ID=9000
WIN_TEMPLATE_ID=9001

# Porta do servidor Node.js
PORT=3001

# Chave de API do Groq (obter em https://console.groq.com)
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PVE_HOST` | Sim | URL completa do Proxmox com protocolo e porta |
| `PVE_NODE` | Sim | Nome do nó Proxmox alvo |
| `PVE_TOKEN_ID` | Sim | ID do token no formato `user@realm!tokenid` |
| `PVE_TOKEN_SECRET` | Sim | Secret do token gerado pelo Proxmox |
| `UBUNTU_TEMPLATE_ID` | Sim* | VMID do template Ubuntu (necessário para criar VMs Linux) |
| `WIN_TEMPLATE_ID` | Não | VMID do template Windows |
| `PORT` | Não | Porta do servidor (padrão: 3001) |
| `GROQ_API_KEY` | Sim* | Chave de API do Groq (necessária para IA) |

*Necessário apenas se a funcionalidade correspondente for utilizada.

---

## 9. Evoluções e Melhorias Futuras

### Alta prioridade

| Melhoria | Descrição |
|---|---|
| **Autenticação** | Adicionar login com JWT ou sessão para proteger o acesso ao dashboard |
| **Multi-nó** | Suporte a múltiplos nós Proxmox em um cluster, não apenas um nó fixo |
| **Métricas históricas** | Gráficos de CPU/memória ao longo do tempo usando RRD data do Proxmox |
| **Containers LXC** | Suporte ao gerenciamento de containers Linux além de VMs QEMU |

### IA e Automação

| Melhoria | Descrição |
|---|---|
| **RAG sobre documentação** | Integrar a documentação do Proxmox VE como base de conhecimento para o assistente responder dúvidas de configuração avançada |
| **Alertas inteligentes** | IA monitora métricas e envia alertas proativos quando detecta anomalias (ex: VM com CPU > 90% por 10 minutos) |
| **Recomendações de otimização** | IA analisa o uso de recursos e sugere redimensionamentos (rightsizing) de VMs ociosas |
| **Assistente multi-turno com memória** | Persistir o histórico de conversas entre sessões para contexto contínuo |
| **Suporte a Windows** | Criar ferramenta `create_windows_vm` no assistente com configuração via Autounattend |

### Infraestrutura

| Melhoria | Descrição |
|---|---|
| **CI/CD pipeline** | GitHub Actions para deploy automático a cada push na branch main |
| **Containerização** | Dockerfile e docker-compose para facilitar o deploy |
| **HTTPS nativo** | Suporte a certificado SSL no backend (Let's Encrypt via Caddy/Nginx) |
| **WebSocket** | Substituir SSE por WebSocket bidirecional para comunicação mais eficiente |
| **Testes automatizados** | Suite de testes de integração para os endpoints críticos |

---

## 10. Modelo de Negócio

### Problema e oportunidade

Empresas que operam infraestrutura própria — especialmente pequenas e médias empresas, provedores de hospedagem e departamentos de TI — enfrentam dificuldades para gerenciar servidores de virtualização Proxmox sem equipes técnicas especializadas. A interface nativa do Proxmox tem curva de aprendizado alta e não oferece automação por linguagem natural.

### Proposta de valor

> **"Gerencie toda a sua infraestrutura de virtualização conversando em português."**

O sistema reduz o tempo necessário para operações rotineiras (criar VMs, fazer backups, diagnosticar problemas) de minutos para segundos, e elimina a necessidade de conhecimento avançado para tarefas comuns.

### Modelos de receita

| Modelo | Descrição | Público-alvo |
|---|---|---|
| **SaaS por assento** | Plano mensal por usuário administrador (R$ 49–199/mês) | PMEs com equipe de TI pequena |
| **Self-hosted Enterprise** | Licença única anual com suporte (R$ 2.000–8.000/ano) | Empresas com política de dados internos |
| **White-label para hosters** | Venda da solução para provedores de hospedagem VPS oferecerem ao cliente final | Provedores de cloud privada |
| **Freemium** | Versão gratuita com limite de VMs (até 3); pago para ilimitado + IA | Homelabbers e startups early-stage |

### Diferenciais competitivos

- Interface em português com assistente IA nativo em PT-BR
- Execução real de operações (não apenas consultas) via linguagem natural
- Deploy simples — um `npm start` e funciona
- Custo de inferência baixo (Groq oferece tier gratuito generoso com LLaMA 3.3-70b)

### Projeção de crescimento

A crescente adoção de Proxmox VE como alternativa gratuita ao VMware ESXi (após a aquisição pela Broadcom e mudanças no licenciamento em 2024) criou uma janela de mercado significativa. Estima-se que mais de 800 mil instalações ativas de Proxmox VE existam globalmente, com crescimento acelerado no segmento SMB.
