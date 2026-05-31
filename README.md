# MegaForm

[简体中文](README.md) | [English](README.en.md)

**面向研究型提问的多模型树状对话系统。**

把"一次提问 → 多模型并行回答 → 沿某条回答分叉深入"的过程组织成一棵可展开、可折叠、可深链接的对话树。


![这是图片](/screenshot.png "Main Page")

![这是图片](/screenshot2.png "Chat Page")

---

## 为什么需要 MegaForm

普通聊天工具是一条线：问一句，答一句，追问继续堆在同一条上下文里。当你需要**比较、分叉和回溯**时，线性对话就捉襟见肘了：

| 场景 | 线性聊天 | MegaForm |
|------|---------|----------|
| 同一问题问多个模型 | 开多个窗口手动比对 | 一个问题，多模型回答并列展示 |
| 针对某个模型的回答追问 | 上下文混入其他模型回复 | 追问只继承当前分支上下文，互不干扰 |
| 选中某句话继续深挖 | 复制粘贴，模型可能忘记前文 | Nut 锚点精准定位，上下文自动注入 |
| 查看之前的分叉思路 | 向上翻半天，不知道哪条是哪条 | 树状结构一目了然，折叠快速导航 |

一棵典型的问题树长这样：

```
根问题 "RLHF 和 DPO 的本质区别是什么？"
├─ GPT-5 的回答
│  └─ 追问 "RLHF 中的 reward model 如何避免 reward hacking？"
│     └─ 进一步追问 "PPO 在 RLHF 中有什么替代方案？"
├─ Claude Sonnet 4.6 的回答
│  └─ 追问 "DPO 的隐式 reward 公式怎么推导？"
└─ DeepSeek V4 Pro 的回答
```

---

## 核心能力

### 多模型并行对话
- 一次提问同时发给多个模型，回答并列展示，便于横向对比
- 支持 **10 个供应商预设**：OpenAI、Anthropic、Gemini、xAI (Grok)、OpenRouter、DeepSeek、智谱 AI、MiniMax、Kimi、通义千问 (Qwen)
- 支持 Ollama 本地模型 + 任意 OpenAI 兼容接口
- 模型选择、思考强度、联网搜索开关按需切换

### 树状对话结构
- **数据模型**：`Root Node → Node → Response → Nut`，精确建模"问题→回答→锚点追问"的关系
- **Progression**（递进探索）：在同一条思路上继续深入，自动纳入兄弟节点的上下文
- **Followup**（追问）：选中回答中的某段文字（Nut），精准追踪该片段继续提问
- 整棵树支持折叠/展开（CSS grid 动画），聚焦模式（面包屑导航 + 节点切换淡入淡出）

### SSE 流式输出
- 后端通过 `asyncio.create_task` 解耦 LLM 调用与 HTTP 连接
- 前端断开后后台继续抓取回复，重连时从数据库恢复
- 节流写入 DB（~32 字符/120ms），保证重连体验的流畅度
- BFS 渐进式加载问题树，大树的加载不阻塞 UI

### 文本锚点（Nut）
- 选中回复中的任意片段 → 弹出追问输入框 → 自动注入"针对你上面答复的「xxx」这段话"上下文
- 追问卡片嵌入原文对应位置，通过三层搜索策略（直接匹配 → Markdown 归一化 → 单词级兜底）定位选区
- 桌面端浮动弹窗 + 移动端全宽底栏，CSS Custom Highlight API 保持高亮

### 联网搜索
- **5 种搜索后端**：Brave、Serper、Tavily、SerpAPI、SearXNG
- **原生模型搜索**：Anthropic web search、Gemini grounding、OpenAI search-preview
- **Tool-calling 搜索**：模型自主调用 `search_web` + `see_web`，最多 7 轮工具调用
- 搜索结果自动注入上下文，引用来源在前端展示

### 深度思考 / Reasoning
- 按模型配置思考预算（budget tokens），前端提供可视化强度选择
- 思考过程实时流式展示（可折叠的 thinking 区域）
- 差异化适配各 API 的思考参数格式：Anthropic extended thinking、DeepSeek `reasoning_effort`、Gemini `thinkingConfig`、OpenAI `reasoning`

### 用量统计与成本追踪
- 每次对话记录 `tokens_input/output`、`latency_ms`、模型和供应商
- 按模型配置价格自动估算消费金额，累计到模型表
- 未返回 usage 的供应商（如 Gemini）按字符数估算 token
- 人民币（¥）和美元（$）双币种支持，按供应商预设自动切换

### 智能摘要
- 节点摘要：手动编辑或调用配置的摘要模型自动生成（25 token 以内）
- 问题树摘要：debounce 1 小时，当日凌晨 3 点全量扫描，自动为深度足够的树生成根摘要
- 侧边栏展示摘要，辅助快速浏览大量问题树

### URL 深链接与分享
- 支持 `/root/{root_id}` 和 `/node/{node_id}` 两种深链接
- 浏览器直接访问 API 端点自动 302 重定向到 SPA 路由
- 支持 popstate 事件，浏览器前进/后退无缝导航

### 多用户与认证
- **本地模式**（默认）：无需登录，单用户使用
- **邮箱注册/登录**：PBKDF2 密码哈希，session cookie 30 天有效期
- **Google OAuth**：一键登录，自动同步头像和昵称
- 模型配置支持**共享**：家庭成员间共享 API Key（加密存储），独立用量追踪
- 用户 Profile（Markdown）：注入 system prompt 作为全局偏好和背景知识

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **后端框架** | Python 3.10+ / FastAPI / uvicorn |
| **数据库** | SQLite (WAL 模式、外键级联、FTS5 全文索引) |
| **异步 HTTP** | httpx (AsyncClient, 流式 SSE 消费) |
| **密钥加密** | cryptography (Fernet, API Key 加密存储) |
| **前端框架** | React 19 + TypeScript + Vite |
| **状态管理** | Zustand (含 localStorage 持久化) |
| **Markdown 渲染** | marked.js + KaTeX (LaTeX) + highlight.js (代码高亮) |
| **UI 组件** | HeroUI + lucide-react + @ant-design/icons |
| **动画** | framer-motion (morphing 弹窗、折叠/展开) |

---

## 项目结构

```
~/projects/megaform/
├── main.py                    # FastAPI 应用、API 路由、SSE 流式编排 (2526 行)
├── database.py                # SQLite schema、CRUD、FTS5 查询、加密/解密 (2347 行)
├── models.py                  # 多模型流式调用、思考/搜索参数适配 (860 行)
├── web_search.py              # 5 种搜索后端 + 网页抓取 (332 行)
├── utility.py                 # 流式 delta 合并工具
├── auth.py                    # 认证：session、邮箱、Google OAuth (191 行)
├── price_crawler.py           # 模型价格同步逻辑
├── requirements.txt           # 后端依赖 (fastapi/uvicorn/httpx/cryptography/jinja2)
├── megaform.db                # SQLite 数据库文件（自动创建）
├── static/dist/               # 前端 Vite 构建产物（生产环境）
└── frontend/
    ├── package.json
    ├── vite.config.ts         # Vite 配置、dev 代理 /api 到 8080
    ├── index.html
    └── src/
        ├── App.tsx            # 根组件：URL 深链接、侧边栏、响应式布局
        ├── api/client.ts      # REST + SSE 客户端
        ├── store/appStore.ts  # Zustand 全局状态 (1896 行)
        ├── types/index.ts     # 前端类型定义
        ├── data/
        │   ├── providerPresets.ts   # 10 个供应商预设（模型列表、价格、思考级别）
        │   └── thinkingPresets.ts   # 思考强度预设
        ├── components/
        │   ├── Sidebar.tsx          # 侧边栏：话题列表、搜索、置顶/归档
        │   ├── ChatArea.tsx         # 主区域：面包屑、冻结模型栏、节点树渲染
        │   ├── InputBar.tsx         # 输入栏：多模型选择、思考强度、联网搜索
        │   ├── NodeCard.tsx         # 节点卡片：折叠、编辑、重跑、删除、沉浸式
        │   ├── ResponseArea.tsx     # 回答区：流式渲染、文本选择追问、模型切换
        │   ├── MarkdownContent.tsx  # Markdown 渲染：代码高亮、LaTeX、Nut 锚点高亮
        │   ├── FrozenModelBar.tsx   # 冻结模型栏：FLIP 动画、模型 tab 切换
        │   └── ConfigModal.tsx      # 配置弹窗：模型/搜索/Profile/账号管理
        └── utils/
            └── latex.ts             # LaTeX 渲染（KaTeX inline + display）
```

---

## 快速启动

### 前置条件

- Python 3.10+
- Node.js 18+
- npm

### 1. 克隆并安装

```bash
cd ~/projects/megaform

# 后端依赖
pip install -r requirements.txt

# 前端依赖
cd frontend && npm install && cd ..
```

### 2. 开发模式

开两个终端：

```bash
# 终端 1：后端（端口 8080，auto-reload）
python main.py
```

```bash
# 终端 2：前端（端口 5173，HMR 热更新）
cd frontend && npm run dev
```

访问 **http://localhost:5173** — Vite 将 `/api` 代理到后端 8080。

### 3. 生产模式

```bash
# 构建前端
cd frontend && npm run build && cd ..

# 启动（FastAPI 同时 serve 前端静态文件）
python main.py
```

访问 **http://localhost:8080**。

数据库文件 `megaform.db` 在项目根目录自动创建并迁移。首次启动无模型配置时自动创建 DeepSeek Chat 占位配置。

---

## 配置指南

### 模型配置

进入前端配置弹窗（⚙️ 齿轮图标），选择供应商预设后填入 API Key 即可。支持的自定义字段：

| 字段 | 说明 |
|------|------|
| `name` | 前端展示名称 |
| `provider` | 供应商类型：`openai` / `deepseek` / `ollama` / `anthropic` / `custom` |
| `base_url` | API 地址（OpenAI 兼容接口可自定义） |
| `api_key` | API Key（Fernet 加密存储，Ollama 本地模型可为空） |
| `model_name` | 供应商侧模型标识名 |
| `max_tokens` | 最大输出 token 数 |
| `price_per_input` | 输入单价（每 1K tokens） |
| `price_per_output` | 输出单价（每 1K tokens） |

### 联网搜索

在设置中配置搜索供应商和 API Key。支持 5 种后端：

| 供应商 | 免费额度 | 付费价格 |
|--------|---------|---------|
| Brave Search | 2,000/月 | $5/1K 次 |
| Serper (Google) | 2,500/月 | $0.30/1K 次 |
| Tavily | 1,000/月 | $0.008/次 |
| SerpAPI | 100/月 | $50/月起 |
| SearXNG | 完全免费 | 自托管 |

### 认证

通过环境变量控制：

```bash
# 认证模式：local（单用户）/ oauth（多用户）
export MEGAFORM_AUTH_MODE=local

# 邮箱注册开关（默认开启）
export MEGAFORM_EMAIL_AUTH=true

# Google OAuth（需在 Google Cloud Console 配置）
export GOOGLE_CLIENT_ID=xxx
export GOOGLE_CLIENT_SECRET=xxx
export GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/google/callback
```

也可以从 `.env.example` 复制一份本地配置：

```bash
cp .env.example .env
```

### Profile

在配置弹窗的 Profile 标签页用 Markdown 编写个人偏好和背景知识，将被注入到 system prompt 中。支持每对话独立开关。

---

## 数据模型

```
┌──────────────┐
│    roots     │  问题树根节点（parent_id IS NULL）
│   (nodes)    │  ├─ pinned / archived / summary
└──────┬───────┘
       │ 1:N
┌──────▼───────┐
│    nodes     │  问题/追问/递进节点
│              │  ├─ relation: progression | followup
│              │  ├─ nut_id → nuts (锚点追问)
│              │  └─ parent_model_id (追问时的模型指向)
└──────┬───────┘
       │ 1:N
┌──────▼───────┐
│  responses   │  模型回答
│              │  ├─ status: streaming | completed | error
│              │  ├─ thinking_budget / sources / meta
│              │  └─ tokens_input / tokens_output / latency_ms
└──────┬───────┘
       │ 1:N
┌──────▼───────┐
│    nuts      │  选中文本锚点
│              │  ├─ seek / end_seek (字符偏移)
│              │  └─ label (选中文本)
└──────────────┘
```

**关键约束：**
- 删除根节点 → 级联删除整棵问题树
- 删除非根节点 → 级联删除该节点及所有后代
- 模型配置采用软删除，保留历史回答中的模型名称和用量信息
- FTS5 全文索引覆盖 `nodes.content` / `nodes.summary` / `responses.content`

---

## API 参考

### 问题树

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/roots` | 列出所有问题树 |
| `GET` | `/api/roots/{id}` | 读取根节点 |
| `PATCH` | `/api/roots/{id}` | 更新根节点（内容、摘要、置顶等） |
| `DELETE` | `/api/roots/{id}` | 删除整棵问题树 |
| `POST` | `/api/roots/{id}/pin` | 置顶/取消置顶 |
| `GET` | `/api/roots/{id}/tree` | 一次性读取完整树 |
| `GET` | `/api/roots/{id}/tree/stream` | SSE 渐进式加载（BFS） |
| `GET` | `/api/roots/{id}/nodes` | 获取扁平节点列表 |

### 节点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/nodes/{id}` | 读取节点（含 responses） |
| `PATCH` | `/api/nodes/{id}` | 更新节点 |
| `DELETE` | `/api/nodes/{id}` | 级联删除节点 |
| `GET` | `/api/nodes/{id}/path` | 获取到根节点的路径 |
| `GET` | `/api/nodes/{id}/children` | 获取子节点 |
| `POST` | `/api/nodes/{id}/summary` | 手动设置摘要 |
| `POST` | `/api/nodes/{id}/generate-summary` | AI 生成摘要 |
| `POST` | `/api/nodes/{id}/rerun/stream` | 重跑节点（SSE 流式） |

### 流式对话

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/chat/stream` | 创建节点 + 多模型并行流式回答 |
| `GET` | `/api/chat/stream/{node_id}` | 断线重连，从 DB 恢复流式输出 |
| `POST` | `/api/node/{node_id}/add-model` | 给已有节点追加模型回答 |

### SSE 事件规范

所有流式端点返回标准 SSE 格式 (`text/event-stream`)：

```
event: node_ready
data: {"root_id": "...", "node_id": "..."}

event: model_start
data: {"node_id": "...", "model_id": "...", "model_name": "..."}

event: thinking
data: {"node_id": "...", "model_id": "...", "content": "..."}

event: content
data: {"node_id": "...", "model_id": "...", "content": "..."}

event: sources
data: {"node_id": "...", "model_id": "...", "sources": [...]}

event: model_done
data: {"node_id": "...", "model_id": "...", "tokens_input": 1234, ...}

event: model_error
data: {"node_id": "...", "model_id": "...", "error": "..."}

event: done
data: {}
```

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/search?q=...` | FTS5 全文搜索 |
| `GET` | `/api/models` | 列出模型配置 |
| `POST` | `/api/models` | 新增/更新模型配置 |
| `GET` | `/api/me` | 当前用户信息 |
| `POST` | `/api/auth/register` | 邮箱注册 |
| `POST` | `/api/auth/login` | 邮箱登录 |
| `POST` | `/api/auth/logout` | 登出 |
| `GET` | `/api/auth/google/start` | Google OAuth 入口 |
| `GET` | `/api/settings` | 读取全局设置 |
| `POST` | `/api/settings` | 批量保存设置 |
| `GET` | `/api/token-usage` | 用量统计 |

---

## 开发指南

### 代码检查

```bash
# 后端语法检查
python -m py_compile main.py database.py models.py web_search.py utility.py auth.py price_crawler.py

# 前端
cd frontend
npm run lint
```

### 构建与验证

```bash
# 构建前清理旧产物（Vite 默认 .js 优先于 .tsx！）
find frontend/src -name "*.js" -delete
rm -rf static/dist/

# 构建
cd frontend && npm run build && cd ..

# 验证构建产物包含关键改动
strings static/dist/assets/index-*.js | grep -o '关键字符串'
```

### 数据库调试

```bash
sqlite3 megaform.db
.tables
.schema nodes
SELECT id, content, relation FROM nodes WHERE parent_id IS NULL;
```

### 前端状态流

```
App.tsx
  ├─ 初始化: fetchRoots() / fetchModels() / URL 深链接解析
  ├─ 打开问题树: openRoot(rootId) → SSE 渐进加载或一次性加载
  ├─ 聚焦节点: focusNode(nodeId) → ChatArea 渲染对应 NodeCard
  ├─ 发送消息: sendingMessage(content, modelIds) → SSE 流式对话
  ├─ 追问: submitFollowup(...) / submitProgression(...)
  └─ 重跑: rerunNode(nodeId, modelIds) → SSE 重跑流
```

### 常见陷阱

- **Vite 构建优先级**：构建前务必删除 `.js` 编译产物，Vite 默认 `.js` 优先于 `.tsx`
- **流式元数据**：`onDone` 回调必须包裹在 `try/finally` 中，避免异常导致状态卡死
- **折叠逻辑**：每个节点仅一个 `collapsed` 布尔，折叠完全独立不波及子节点
- **中文输入法**：InputBar 在 composition 期间忽略 Enter 键，避免误提交
- **Gemini 端点**：始终走原生 API（`generativelanguage.googleapis.com`），避免 OpenAI 兼容端点 400 错误

---

## License

Apache-2.0
