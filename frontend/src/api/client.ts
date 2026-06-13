/**
 * MegaForm API Client
 */
import type {
  Root, RootGroup, Node, Response as Resp, Nut,
  ModelConfig, TokenUsage, TokenUsageResponse, ChatRequest, ChatResponse,
  UserProfile, UserProfileVersion,
  StreamCallbacks,
  SSEDone,
  MeResponse,
  AuthResponse,
} from '../types';

/** API 基础路径，所有请求的前缀 */
const BASE = '/api';

/**
 * 通用 fetch 封装，自动添加 Content-Type 头，解析 JSON 响应
 * @param path - API 路径（不含基础前缀）
 * @param options - fetch 配置，可选
 * @returns 解析后的 JSON 响应体
 * @throws 响应非 2xx 时抛出 Error，message 来自后端 error 字段或 statusText
 */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── SSE 流式请求 ──

function parseSSEPart(part: string): { eventType: string; eventData: string } | null {
  let eventType = '';
  const dataLines: string[] = [];

  for (const line of part.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      const value = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      dataLines.push(value);
    }
  }

  if (!eventType || dataLines.length === 0) return null;
  return { eventType, eventData: dataLines.join('\n') };
}

/**
 * SSE 流式加载问题树，BFS 顺序逐节点推送
 *
 * 事件类型：
 * - root:  推送根节点 → onRoot
 * - node:  逐个推送子节点 → onNode
 * - done:  全部推送完成 → onDone
 *
 * @param rootId - 问题树 ID
 * @param callbacks - 事件回调：onRoot / onNode / onDone / onError
 */
export async function streamRootTree(
  rootId: string,
  callbacks: {
    onRoot: (node: Node) => void;
    onNode: (node: Node) => void;
    onDone: () => void;
    onError: (error: string) => void;
  }
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/roots/${rootId}/tree/stream`, { credentials: 'same-origin' });
  } catch (e: any) {
    callbacks.onError(e?.message || 'Failed to fetch tree stream');
    return;
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    callbacks.onError(errBody.error || res.statusText);
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) continue;
        const parsedPart = parseSSEPart(part);

        if (!parsedPart?.eventType) {
          console.warn('[tree/stream] 跳过无 eventType 的事件:', part.slice(0, 100));
          continue;
        }
        if (!parsedPart.eventData) {
          console.warn('[tree/stream] 跳过空 data 事件:', parsedPart.eventType);
          continue;
        }
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try {
          parsed = JSON.parse(eventData);
        } catch (e) {
          console.error('[tree/stream] JSON 解析失败:', eventType, String(e).slice(0, 100));
          continue;
        }

        switch (eventType) {
          case 'root':
            if (parsed.node) callbacks.onRoot(parsed.node);
            else console.error('[tree/stream] root 事件缺少 node 字段');
            break;
          case 'node':
            if (parsed.node) callbacks.onNode(parsed.node);
            else console.error('[tree/stream] node 事件缺少 node 字段');
            break;
          case 'done':
            callbacks.onDone();
            return;
          default:
            console.warn('[tree/stream] 未知事件类型:', eventType);
        }
      }
    }
  } catch (e: any) {
    console.error('[tree/stream] 流读取异常:', e);
    callbacks.onError(`流读取中断: ${e?.message || String(e)}`);
    return;
  } finally {
    reader.releaseLock();
  }

  // 流正常结束但没有收到 done 事件 → 也算完成
  callbacks.onDone();
}

/**
 * SSE 流式聊天，与后端建立长连接接收逐 token 响应
 *
 * 事件类型：
 * - node_created: 节点已创建 → onNodeCreated
 * - model_start:  模型开始响应 → onModelStart
 * - thinking:     深度思考流 → onThinking
 * - content:      正文流 → onContent
 * - model_done:   单个模型流结束 → onModelDone
 * - model_error:  模型响应出错 → onModelError
 * - sources:      原生搜索引用来源 → onSources
 * - done:         全部完成 → onDone (携带 node_id)
 *
 * @param data - 聊天请求参数（见 ChatRequest 类型）
 * @param callbacks - 流式事件回调（见 StreamCallbacks 类型）
 * @throws 请求失败（非 2xx）时抛出 Error
 */
export async function chatStream(data: ChatRequest, callbacks: StreamCallbacks): Promise<void> {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按 \n\n 分割 SSE 事件
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';  // 保留最后一个不完整的部分

      for (const part of parts) {
        const parsedPart = parseSSEPart(part);
        if (!parsedPart) continue;
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          continue;
        }

        switch (eventType) {
          case 'node_created':
            callbacks.onNodeCreated?.(parsed);
            break;
          case 'model_start':
            callbacks.onModelStart?.(parsed);
            break;
          case 'thinking':
            callbacks.onThinking?.(parsed);
            break;
          case 'content':
            callbacks.onContent?.(parsed);
            break;
          case 'model_done':
            callbacks.onModelDone?.(parsed);
            break;
          case 'model_error':
            callbacks.onModelError?.(parsed);
            break;
          case 'sources':
            callbacks.onSources?.(parsed);
            break;
          case 'done':
            callbacks.onDone?.(parsed as SSEDone);
            break;
        }

        // 每个事件后 yield，让 React 有机会逐帧渲染（避免 50 个 chunk 合并成 1 帧）
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function importPdfStream(
  data: { file: File; rootId?: string | null; parentId?: string | null; relation?: 'followup' | 'progression'; cardContent?: string },
  callbacks: StreamCallbacks
): Promise<void> {
  const params = new URLSearchParams();
  params.set('filename', data.file.name);
  if (data.rootId) params.set('root_id', data.rootId);
  if (data.parentId) params.set('parent_id', data.parentId);
  params.set('relation', data.relation || 'progression');
  if (data.cardContent?.trim()) params.set('card_content', data.cardContent.trim());

  const res = await fetch(`${BASE}/pdf/import/stream?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Filename': data.file.name,
    },
    credentials: 'same-origin',
    body: data.file,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const parsedPart = parseSSEPart(part);
        if (!parsedPart) continue;
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          continue;
        }

        switch (eventType) {
          case 'node_created':
            callbacks.onNodeCreated?.(parsed);
            break;
          case 'model_start':
            callbacks.onModelStart?.(parsed);
            break;
          case 'thinking':
            callbacks.onThinking?.(parsed);
            break;
          case 'content':
            callbacks.onContent?.(parsed);
            break;
          case 'model_done':
            callbacks.onModelDone?.(parsed);
            break;
          case 'model_error':
            callbacks.onModelError?.(parsed);
            break;
          case 'done':
            callbacks.onDone?.(parsed as SSEDone);
            break;
        }

        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function importPdfUrlStream(
  data: { url: string; filename?: string; rootId?: string | null; parentId?: string | null; relation?: 'followup' | 'progression'; cardContent?: string },
  callbacks: StreamCallbacks
): Promise<void> {
  const res = await fetch(`${BASE}/pdf/import-url/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      url: data.url,
      filename: data.filename,
      root_id: data.rootId,
      parent_id: data.parentId,
      relation: data.relation || 'progression',
      card_content: data.cardContent,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const parsedPart = parseSSEPart(part);
        if (!parsedPart) continue;
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          continue;
        }

        switch (eventType) {
          case 'node_created':
            callbacks.onNodeCreated?.(parsed);
            break;
          case 'model_start':
            callbacks.onModelStart?.(parsed);
            break;
          case 'thinking':
            callbacks.onThinking?.(parsed);
            break;
          case 'content':
            callbacks.onContent?.(parsed);
            break;
          case 'model_done':
            callbacks.onModelDone?.(parsed);
            break;
          case 'model_error':
            callbacks.onModelError?.(parsed);
            break;
          case 'done':
            callbacks.onDone?.(parsed as SSEDone);
            break;
        }

        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function importMarkdownStream(
  data: { file: File; rootId?: string | null; parentId?: string | null; relation?: 'followup' | 'progression'; cardContent?: string },
  callbacks: StreamCallbacks
): Promise<void> {
  const params = new URLSearchParams();
  params.set('filename', data.file.name);
  if (data.rootId) params.set('root_id', data.rootId);
  if (data.parentId) params.set('parent_id', data.parentId);
  params.set('relation', data.relation || 'progression');
  if (data.cardContent?.trim()) params.set('card_content', data.cardContent.trim());

  const res = await fetch(`${BASE}/markdown/import/stream?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Filename': data.file.name,
    },
    credentials: 'same-origin',
    body: data.file,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const parsedPart = parseSSEPart(part);
        if (!parsedPart) continue;
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          continue;
        }

        switch (eventType) {
          case 'node_created':
            callbacks.onNodeCreated?.(parsed);
            break;
          case 'model_start':
            callbacks.onModelStart?.(parsed);
            break;
          case 'thinking':
            callbacks.onThinking?.(parsed);
            break;
          case 'content':
            callbacks.onContent?.(parsed);
            break;
          case 'model_done':
            callbacks.onModelDone?.(parsed);
            break;
          case 'model_error':
            callbacks.onModelError?.(parsed);
            break;
          case 'done':
            callbacks.onDone?.(parsed as SSEDone);
            break;
        }

        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 重连流式聊天 — 当页面恢复/刷新时重新订阅正在进行的 LLM 输出。
 *
 * 与 chatStream 不同，这个端点通过 GET 请求连接，
 * 后端通过 DB 轮询方式返回增量内容（而不是队列读取）。
 *
 * 事件类型与 chatStream 完全兼容：
 *   model_start / thinking / content / model_done / model_error / done
 *
 * @param nodeId - 要重连的节点 ID
 * @param callbacks - 流式事件回调
 */
export async function reconnectChatStream(nodeId: string, callbacks: StreamCallbacks): Promise<void> {
  const res = await fetch(`${BASE}/chat/stream/${nodeId}`, { credentials: 'same-origin' });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const parsedPart = parseSSEPart(part);
        if (!parsedPart) continue;
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          continue;
        }

        switch (eventType) {
          case 'model_start':
            callbacks.onModelStart?.(parsed);
            break;
          case 'thinking':
            callbacks.onThinking?.(parsed);
            break;
          case 'content':
            callbacks.onContent?.(parsed);
            break;
          case 'model_done':
            callbacks.onModelDone?.(parsed);
            break;
          case 'model_error':
            callbacks.onModelError?.(parsed);
            break;
          case 'sources':
            callbacks.onSources?.(parsed);
            break;
          case 'done':
            callbacks.onDone?.(parsed as SSEDone);
            return;
        }

        // 每个事件后 yield，让 React 有机会逐帧渲染
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }

  // 流正常结束但未收到 done
  callbacks.onDone?.({ node_id: nodeId });
}


/**
 * 流式重跑节点 — SSE 实时输出，体验与发送新问题一致。
 *
 * 端点: POST /api/nodes/{nodeId}/rerun/stream
 * 事件类型: node_ready / model_start / thinking / content / model_done / model_error / done
 *
 * @param nodeId - 要重跑的节点 ID
 * @param data - { content?, model_ids?, thinking_budgets? }
 * @param callbacks - 流式事件回调（与 chatStream 兼容）
 */
export async function rerunNodeStream(
  nodeId: string,
  data: { content?: string; model_ids?: string[]; thinking_budgets?: Record<string, number>; web_search?: boolean; use_profile?: boolean },
  callbacks: StreamCallbacks,
): Promise<void> {
  const res = await fetch(`${BASE}/nodes/${nodeId}/rerun/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const parsedPart = parseSSEPart(part);
        if (!parsedPart) continue;
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          continue;
        }

        switch (eventType) {
          case 'node_ready':
            callbacks.onNodeCreated?.(parsed);  // 复用 onNodeCreated
            break;
          case 'model_start':
            callbacks.onModelStart?.(parsed);
            break;
          case 'thinking':
            callbacks.onThinking?.(parsed);
            break;
          case 'content':
            callbacks.onContent?.(parsed);
            break;
          case 'model_done':
            callbacks.onModelDone?.(parsed);
            break;
          case 'model_error':
            callbacks.onModelError?.(parsed);
            break;
          case 'done':
            callbacks.onDone?.(parsed as SSEDone);
            break;
        }

        // 每个事件后 yield，让 React 有机会逐帧渲染
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    reader.releaseLock();
  }
}


// ── Roots ──

/**
 * API 方法集合，封装所有 REST 端点调用
 *
 * 分类：
 * - Roots:     问题 CRUD + 问题树/节点列表
 * - Nodes:      节点 CRUD + 折叠/摘要/重跑
 * - Responses:  模型响应 CRUD
 * - Nuts:       对响应的文本片段标注（精华摘录）
 * - Chat:       非流式聊天（保留兼容）
 * - Models:     模型配置管理 + 获取/创建/删除/设置默认/自动发现
 * - Token usage / Settings: 用量统计与全局设置
 */
export const api = {
  // Auth
  /** 获取当前登录用户 */
  getMe: () => request<MeResponse>('/me'),
  /** 邮箱注册 */
  register: (data: { email: string; password: string; display_name?: string; locale?: string }) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 邮箱登录 */
  login: (data: { email: string; password: string; locale?: string }) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** Google OAuth 登录跳转地址 */
  googleLoginUrl: (next = '/', locale?: string) =>
    `${BASE}/auth/google/start?next=${encodeURIComponent(next)}${locale ? `&locale=${encodeURIComponent(locale)}` : ''}`,
  /** 更新当前用户语言 */
  updateLocale: (data: { locale: string }) =>
    request<AuthResponse>('/me/locale', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 退出当前设备 */
  logout: () => request<{ status: string }>('/auth/logout', { method: 'POST' }),
  /** 退出所有设备 */
  logoutAll: () => request<{ status: string; revoked_sessions: number }>('/auth/logout-all', { method: 'POST' }),

  // Roots
  /** 获取所有问题树根节点（按分组和组内顺序排序） */
  listRoots: () => request<Root[]>('/roots'),
  /** 获取侧边栏分组 */
  listRootGroups: () => request<RootGroup[]>('/root-groups'),
  /** 新建侧边栏分组 */
  createRootGroup: (data: { name: string }) =>
    request<RootGroup>('/root-groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 更新侧边栏分组 */
  updateRootGroup: (id: string, data: Partial<RootGroup>) =>
    request<RootGroup>(`/root-groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /** 删除侧边栏分组，组内问题树回到默认“对话” */
  deleteRootGroup: (id: string) =>
    request<{ status: string }>(`/root-groups/${id}`, { method: 'DELETE' }),
  /** 获取单个根节点详情 */
  getRoot: (id: string) => request<Root>(`/roots/${id}`),
  /** 更新根节点属性（摘要、置顶等） */
  updateRoot: (id: string, data: Partial<Root>) =>
    request<Root>(`/roots/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /** 删除整棵问题树 */
  deleteRoot: (id: string) =>
    request<{ status: string }>(`/roots/${id}`, { method: 'DELETE' }),
  /** 移动问题树到侧边栏分组，不改变对话更新时间 */
  moveRootToGroup: (id: string, data: { group_id: string | null }) =>
    request<Root>(`/roots/${id}/group`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Root Tree
  /** 获取问题树结构（含 root 单根节点） */
  getRootTree: (rootId: string) =>
    request<{ root: Node | null }>(`/roots/${rootId}/tree`),
  /** 获取问题树下所有节点的扁平列表 */
  getRootNodes: (rootId: string) =>
    request<Node[]>(`/roots/${rootId}/nodes`),

  // Nodes
  /** 获取节点详情（含关联的模型响应列表） */
  getNode: (nodeId: string) =>
    request<Node & { responses: Resp[] }>(`/nodes/${nodeId}`),
  /** 获取节点从根到自身的路径链 */
  getNodePath: (nodeId: string) =>
    request<Node[]>(`/nodes/${nodeId}/path`),
  /** 获取节点的直接子节点列表 */
  getNodeChildren: (nodeId: string) =>
    request<Node[]>(`/nodes/${nodeId}/children`),
  /** 更新节点内容或元信息 */
  updateNode: (nodeId: string, data: Partial<Node>) =>
    request<Node>(`/nodes/${nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /** 删除节点（V3: 如果删除的是问题根节点，后端返回 deleted_root=true） */
  deleteNode: (nodeId: string) =>
    request<{ status: string; deleted_root?: boolean; root_id?: string; deleted_count?: number }>(`/nodes/${nodeId}`, { method: 'DELETE' }),
  /** 折叠/展开节点，可选传入 AI 摘要 */
  collapseNode: (nodeId: string, collapsed: boolean, summary?: string) =>
    request<{ status: string }>(`/nodes/${nodeId}/collapse`, {
      method: 'POST',
      body: JSON.stringify({ collapsed, summary }),
    }),
  /** 为节点生成 AI 摘要 */
  generateSummary: (nodeId: string, opts?: { force?: boolean }) =>
    request<{ summary: string; updated?: boolean; disabled?: boolean; skipped?: boolean }>(`/nodes/${nodeId}/generate-summary`, {
      method: 'POST',
      body: opts ? JSON.stringify(opts) : undefined,
    }),
  /** 手动设置节点摘要 */
  updateSummary: (nodeId: string, summary: string) =>
    request<{ status: string }>(`/nodes/${nodeId}/summary`, {
      method: 'POST',
      body: JSON.stringify({ summary }),
    }),
  /** 重跑节点（重新向模型发送该节点的问题） */
  rerunNode: (nodeId: string, data: { content?: string; model_ids?: string[] }) =>
    request<{ node_id: string; root_id: string; results: any[] }>(`/nodes/${nodeId}/rerun`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Responses
  /** 获取节点所有模型响应 */
  getNodeResponses: (nodeId: string) =>
    request<Resp[]>(`/nodes/${nodeId}/responses`),
  /** 获取单个响应详情 */
  getResponse: (responseId: string) =>
    request<Resp>(`/responses/${responseId}`),
  /** 更新响应属性 */
  updateResponse: (responseId: string, data: Partial<Resp>) =>
    request<Resp>(`/responses/${responseId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /** 删除响应 */
  deleteResponse: (responseId: string) =>
    request<{ status: string }>(`/responses/${responseId}`, { method: 'DELETE' }),

  // Nuts
  /** 在响应文本中创建坚果（文本片段标注） */
  createNut: (responseId: string, seek: number, end_seek: number, label = '') =>
    request<Nut>(`/responses/${responseId}/nuts`, {
      method: 'POST',
      body: JSON.stringify({ seek, end_seek, label }),
    }),
  /** 列出某条响应上所有坚果 */
  listNuts: (responseId: string) =>
    request<Nut[]>(`/responses/${responseId}/nuts`),
  /** 删除坚果 */
  deleteNut: (nutId: string) =>
    request<{ status: string }>(`/nuts/${nutId}`, { method: 'DELETE' }),

  // Chat (非流式，保留兼容)
  /** 非流式聊天（传统请求-响应模式，用于补发/重试等场景） */
  chat: (data: ChatRequest) =>
    request<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Search
  /** 全局搜索，可按侧边栏分组限定 */
  search: (q: string, groupIds: string[] = []) => {
    const params = new URLSearchParams({ q });
    groupIds.forEach(groupId => params.append('group_id', groupId));
    return request<any[]>(`/search?${params.toString()}`);
  },

  // Models
  /** 获取所有模型配置列表及已选模型 */
  listModels: () =>
    request<{ models: ModelConfig[]; selected_model_ids: string[]; summary_model_id: string; summary_auto_enabled: boolean; profile_update_model_id: string; thinking_budgets: Record<string, number>; schema: any }>('/models'),
  /** 创建或更新模型配置 */
  saveModel: (data: Partial<ModelConfig>) =>
    request<{ id: string; status: string }>('/models', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 删除模型配置 */
  deleteModel: (modelId: string) =>
    request<{ status: string }>(`/models/${modelId}`, { method: 'DELETE' }),
  /** 自动发现模型（根据 provider + base_url + api_key 探测可用模型列表） */
  discoverModels: (provider: string, baseUrl: string, apiKey: string) =>
    request<{ status: string; models: Array<{ model_name: string; name: string; source: string; owned_by?: string }> }>('/models/discover', {
      method: 'POST',
      body: JSON.stringify({ provider, base_url: baseUrl, api_key: apiKey }),
    }),

  // Token usage
  /** 获取 Token 用量统计 */
  getTokenUsage: () => request<TokenUsageResponse>('/token-usage'),
  /** 以当前定价重新计算指定模型的累计消费 */
  recalculateCost: (modelId: string) =>
    request<{ cumulative_usage: number; total_input: number; total_output: number }>(
      `/model-configs/${modelId}/recalculate-cost`,
      { method: 'POST' },
    ),

  // Settings
  /** 获取全局设置键值对 */
  getSettings: () => request<Record<string, string>>('/settings'),
  /** 保存全局设置 */
  saveSettings: (data: Record<string, string>) =>
    request<{ status: string }>('/settings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // User profile
  /** 获取当前用户全局 Profile Markdown */
  getProfile: () => request<UserProfile>('/profile'),
  /** 保存当前用户全局 Profile Markdown */
  saveProfile: (data: { content: string; injection_enabled: boolean; profile_update_model_id?: string; note?: string }) =>
    request<UserProfile & { status: string }>('/profile', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 获取 Profile 版本历史 */
  getProfileHistory: () => request<UserProfileVersion[]>('/profile/history'),
  /** 恢复某个 Profile 历史版本 */
  restoreProfileVersion: (versionId: string) =>
    request<UserProfile & { status: string }>(`/profile/history/${versionId}/restore`, {
      method: 'POST',
    }),

  // Search
  /** 获取可用搜索服务提供商列表 */
  getSearchProviders: () => request<any[]>('/search-providers'),
};


/** 为已有节点追加模型回复的参数 */
export interface AddModelRequest {
  model_id: string;
  thinking_budget?: number;
  web_search?: boolean;
}

/** add-model 流式回调（无 onNodeCreated，节点已存在） */
export interface AddModelCallbacks {
  onModelStart?: (data: import('../types').SSEModelStart) => void;
  onThinking?: (data: import('../types').SSEThinking) => void;
  onContent?: (data: import('../types').SSEContent) => void;
  onModelDone?: (data: import('../types').SSEModelDone) => void;
  onModelError?: (data: import('../types').SSEModelError) => void;
  onDone?: (data: import('../types').SSEDone) => void;
}

/**
 * 为已有节点追加一个模型回复（流式 SSE）
 */
export async function addModelStream(
  nodeId: string,
  data: AddModelRequest,
  callbacks: AddModelCallbacks,
): Promise<void> {
  const res = await fetch(`${BASE}/node/${nodeId}/add-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const parsedPart = parseSSEPart(part);
        if (!parsedPart) continue;
        const { eventType, eventData } = parsedPart;

        let parsed: any;
        try { parsed = JSON.parse(eventData); } catch { continue; }

        switch (eventType) {
          case 'model_start':
            callbacks.onModelStart?.(parsed);
            break;
          case 'thinking':
            callbacks.onThinking?.(parsed);
            break;
          case 'content':
            callbacks.onContent?.(parsed);
            break;
          case 'model_done':
            callbacks.onModelDone?.(parsed);
            break;
          case 'model_error':
            callbacks.onModelError?.(parsed);
            break;
          case 'done':
            callbacks.onDone?.(parsed as SSEDone);
            return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  callbacks.onDone?.({ node_id: nodeId });
}
