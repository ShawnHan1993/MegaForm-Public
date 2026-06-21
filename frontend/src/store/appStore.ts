/**
 * MegaForm 全局状态 Store (Zustand)
 */
import { create } from 'zustand';
import { api, chatStream, reconnectChatStream, rerunNodeStream, streamRootTree, addModelStream, importPdfStream, importPdfUrlStream, importMarkdownStream } from '../api/client';
import type { Root, RootGroup, Node, Response as Resp, ModelConfig, StreamingResponse, Nut } from '../types';
import { getLanguage, tr } from '../i18n';
import type { ImageAttachment } from '../utils/multimodal';
import { getNutReferenceText } from '../utils/referenceText';

// ── localStorage 持久化：折叠状态 ──
const LS_COLLAPSED_PREFIX = 'megaform-collapsed-';
const RECENT_NODE_LIMIT = 10;
const RECENT_NODE_UPDATE_DELAY_MS = 1000;
const AUTO_COLLAPSE_NODE_THRESHOLD = 120;
const recentNodeUpdateTimers = new Map<string, number>();

function hasCollapsedSetPreference(rootId: string): boolean {
  try {
    return localStorage.getItem(LS_COLLAPSED_PREFIX + rootId) !== null;
  } catch { return false; }
}

function loadCollapsedSet(rootId: string): Set<string> {
  try {
    const raw = localStorage.getItem(LS_COLLAPSED_PREFIX + rootId);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveCollapsedSet(rootId: string | null, set: Set<string>) {
  if (!rootId) return;
  try {
    if (set.size > 0) {
      localStorage.setItem(LS_COLLAPSED_PREFIX + rootId, JSON.stringify([...set]));
    } else {
      localStorage.removeItem(LS_COLLAPSED_PREFIX + rootId);
    }
  } catch { /* storage full, silently ignore */ }
}

// ── 工具函数：解析 node.meta ──
/**
 * 安全解析 JSON 字符串为对象，解析失败返回空对象
 * @param metaStr - 节点的 meta JSON 字符串
 * @returns 解析后的对象（失败时返回 {}）
 */
function parseMeta(metaStr: string | undefined): Record<string, any> {
  try { return JSON.parse(metaStr || '{}'); }
  catch { return {}; }
}

// ── 工具函数：把扁平 nodes 列表转成树 ──
/**
 * 将扁平的节点列表构建为树形结构，并按 child_order 排序
 *
 * @param nodes - 节点扁列表
 * @param responses - 节点 ID → 模型响应数组的映射
 * @returns 排序后的根节点数组
 */
function buildTree(nodes: Node[], responses: Record<string, Resp[]>): Node[] {
  const map = new Map<string, Node>();
  for (const n of nodes) {
    map.set(n.id, { ...n, responses: responses[n.id] || [], children: [] });
  }
  const roots: Node[] = [];
  for (const n of nodes) {
    const node = map.get(n.id)!;
    if (n.parent_id && map.has(n.parent_id)) {
      map.get(n.parent_id)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }
  // 按 child_order 排序
  const sortChildren = (list: Node[]) => {
    list.sort((a, b) => a.child_order - b.child_order);
    for (const n of list) {
      if (n.children && n.children.length > 0) sortChildren(n.children);
    }
  };
  sortChildren(roots);
  return roots;
}

function isLogicalNode(node: Node): boolean {
  try {
    return JSON.parse(node.meta || '{}').kind === 'logic';
  } catch {
    return false;
  }
}

function canCollapseNode(node: Node): boolean {
  return isLogicalNode(node)
    || !!(node.children && node.children.length > 0)
    || !!(node.responses && node.responses.length > 0);
}

function countNodeDescendants(node: Node): number {
  const children = node.children || [];
  return children.reduce((sum, child) => sum + 1 + countNodeDescendants(child), 0);
}

function countTreeNodes(nodes: Node[]): number {
  let count = 0;
  const walk = (list: Node[]) => {
    for (const node of list) {
      count += 1;
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return count;
}

function getAutoCollapsedSetForLargeTree(nodes: Node[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: Node[], depth: number) => {
    for (const node of list) {
      if (depth >= 1 && canCollapseNode(node)) ids.add(node.id);
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return ids;
}

function getFollowupQuoteForNode(node: Node, lookup: (id: string) => Node | null): string | null {
  if (node.relation !== 'followup' || !node.nut_id || !node.parent_id) return node.followup_quote || null;
  const parent = lookup(node.parent_id);
  if (!parent?.responses) return node.followup_quote || null;
  for (const response of parent.responses) {
    const nut = response.nuts?.find(n => n.id === node.nut_id);
    if (nut) return getNutReferenceText(response.content, nut, nut.label || node.followup_quote || '');
  }
  return node.followup_quote || null;
}

function clearRecentNodeTimers(nodeIds: Iterable<string>) {
  for (const nodeId of nodeIds) {
    const timer = recentNodeUpdateTimers.get(nodeId);
    if (timer) window.clearTimeout(timer);
    recentNodeUpdateTimers.delete(nodeId);
  }
}

/**
 * 扫描问题树中是否有 status="streaming" 的 response，如有则自动重连。
 * 在 openRoot 完成后调用，确保已断开的流式输出不会丢失。
 */
function _checkAndResumeStreaming(state: AppState) {
  const tree = state.rootTree;
  if (!tree) return;

  // BFS 扫描所有节点
  const queue = [...tree];
  const nodesToResume: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    // 检查该节点的 responses 是否有 streaming 状态
    const responses = (node as any).responses as any[] | undefined;
    if (responses) {
      const streamingResp = responses.find(r => r.status === 'streaming');
      if (streamingResp) {
        // 如果节点已在活跃流式中（有正在运行的 SSE 连接），跳过 — 避免重复 resume
        if (state.streamingNodeIds.has(node.id)) {
          console.log('[auto-reconnect] 节点已在流式中，跳过 resume:', node.id);
        } else {
          nodesToResume.push(node.id);
        }
      }
    }
    if (node.children) queue.push(...node.children);
  }

  if (nodesToResume.length > 0) {
    console.log('[auto-reconnect] 检测到 streaming responses:', nodesToResume);
    // 延迟一帧执行，让 UI 先渲染
    setTimeout(() => {
      for (const nodeId of nodesToResume) {
        state.resumeStreaming(nodeId);
      }
    }, 100);
  }
}

/** 为 streamingResponses 生成组合键 */
function srKey(nodeId: string, modelId: string): string {
  return `${nodeId}:${modelId}`;
}

/**
 * 从 streamingResponses 中提取指定 node 的流式响应子集
 */
function getNodeStreamingResponses(
  streamingResponses: Record<string, StreamingResponse>,
  nodeId: string,
): Record<string, StreamingResponse> {
  const prefix = nodeId + ':';
  const result: Record<string, StreamingResponse> = {};
  for (const [key, val] of Object.entries(streamingResponses)) {
    if (key.startsWith(prefix)) {
      const modelId = key.slice(prefix.length);
      result[modelId] = val;
    }
  }
  return result;
}

function removeNodeStreamingResponses(
  streamingResponses: Record<string, StreamingResponse>,
  nodeId: string,
): Record<string, StreamingResponse> {
  const prefix = nodeId + ':';
  const next = { ...streamingResponses };
  for (const key of Object.keys(next)) {
    if (key.startsWith(prefix)) delete next[key];
  }
  return next;
}

function removeStreamingResponseKeys(
  streamingResponses: Record<string, StreamingResponse>,
  nodeId: string,
  modelIds: string[],
): Record<string, StreamingResponse> {
  const next = { ...streamingResponses };
  for (const modelId of modelIds) {
    delete next[srKey(nodeId, modelId)];
  }
  return next;
}

function hasNodeStreamingResponses(
  streamingResponses: Record<string, StreamingResponse>,
  nodeId: string,
): boolean {
  const prefix = nodeId + ':';
  return Object.keys(streamingResponses).some(key => key.startsWith(prefix));
}

type StoreSet = (
  partial: Partial<AppState> | AppState | ((state: AppState) => Partial<AppState> | AppState),
  replace?: false,
) => void;

const STREAMING_FLUSH_MS = 80;
const pendingStreamingDeltas = new Map<string, { thinking: string; content: string; status: 'thinking' | 'responding' }>();
let streamingFlushTimer: number | null = null;

function flushStreamingDeltas(set: StoreSet) {
  if (streamingFlushTimer !== null) {
    window.clearTimeout(streamingFlushTimer);
    streamingFlushTimer = null;
  }
  if (pendingStreamingDeltas.size === 0) return;

  const deltas = new Map(pendingStreamingDeltas);
  pendingStreamingDeltas.clear();

  set(state => {
    let changed = false;
    const streamingResponses = { ...state.streamingResponses };
    for (const [key, delta] of deltas) {
      const resp = streamingResponses[key];
      if (!resp) continue;
      changed = true;
      streamingResponses[key] = {
        ...resp,
        thinking: resp.thinking + delta.thinking,
        content: resp.content + delta.content,
        status: delta.status,
      };
    }
    return changed ? { streamingResponses } : {};
  });
}

function queueStreamingDelta(
  set: StoreSet,
  key: string,
  delta: { thinking?: string; content?: string; status: 'thinking' | 'responding' },
) {
  const pending = pendingStreamingDeltas.get(key) || { thinking: '', content: '', status: delta.status };
  pending.thinking += delta.thinking || '';
  pending.content += delta.content || '';
  pending.status = delta.status === 'responding' ? 'responding' : pending.status;
  pendingStreamingDeltas.set(key, pending);

  if (streamingFlushTimer !== null) return;
  streamingFlushTimer = window.setTimeout(() => flushStreamingDeltas(set), STREAMING_FLUSH_MS);
}

function mergeResponsesByModel(existing: any[] | undefined, incoming: any[]): any[] {
  const merged = [...(existing || [])];
  for (const resp of incoming) {
    const idx = merged.findIndex((r: any) => r.model_id === resp.model_id);
    if (idx >= 0) merged[idx] = resp;
    else merged.push(resp);
  }
  return merged;
}

async function loadNodeResponsesOrFallback(nodeId: string, fallback: any[], logLabel: string): Promise<any[]> {
  try {
    const responses = await api.getNodeResponses(nodeId);
    return responses.length > 0 ? responses : fallback;
  } catch (e) {
    console.error(`[${logLabel}] getNodeResponses failed:`, e);
    return fallback;
  }
}

/**
 * 将刚自动创建的追问 Nut 热补丁到父节点对应 response.nuts。
 *
 * 刷新后位置恢复正常，说明后端 DB 已正确写入 nut；问题发生在当前会话内存树：
 * node_created 只把 followup child 挂到 parent.children，但父 response.nuts 仍缺少新 nut，
 * ResponseArea 便会把该 child 判定为 withoutNut 并渲染到父节点底部。
 */
function patchNutIntoParentResponse(
  nodes: any[],
  parentId: string | undefined,
  parentModelId: string | undefined,
  nut: Nut | null | undefined,
): void {
  if (!parentId || !parentModelId || !nut) return;

  const visit = (list: any[]): boolean => {
    for (const node of list) {
      if (node.id === parentId) {
        const responses = (node.responses || []) as Resp[];
        const response = responses.find(r => r.id === nut.response_id || r.model_id === parentModelId);
        if (response) {
          const existing = response.nuts || [];
          if (!existing.some(n => n.id === nut.id)) {
            response.nuts = [...existing, nut].sort((a, b) => a.end_seek - b.end_seek);
          }
        }
        return true;
      }
      if (node.children?.length && visit(node.children)) return true;
    }
    return false;
  };

  visit(nodes);
}

function bumpRecentModelUsage(models: ModelConfig[], modelId: string, tokenDelta = 0): ModelConfig[] {
  return models.map(model => {
    if (model.id !== modelId) return model;
    return {
      ...model,
      recent_usage_count: (model.recent_usage_count || 0) + 1,
      recent_token_usage: (model.recent_token_usage || 0) + tokenDelta,
    };
  });
}

function estimateTextTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9_]+/g) || []).length;
  const other = Math.floor(text.replace(/[\s\u3400-\u9fffA-Za-z0-9_]/g, '').length / 2);
  return cjk + words + other;
}

function patchNodeSummaryInTree(nodes: Node[], nodeId: string, summary: string): boolean {
  for (const node of nodes) {
    if (node.id === nodeId) {
      node.summary = summary;
      return true;
    }
    if (node.children?.length && patchNodeSummaryInTree(node.children, nodeId, summary)) {
      return true;
    }
  }
  return false;
}

function patchRootSummary(roots: Root[], nodeId: string, summary: string): { roots: Root[]; patched: boolean } {
  let patched = false;
  const nextRoots = roots.map(root => {
    if (root.id !== nodeId) return root;
    patched = true;
    return { ...root, summary };
  });
  return { roots: nextRoots, patched };
}

function patchRecentNodeSummary(recentNodes: Node[], nodeId: string, summary: string): { recentNodes: Node[]; patched: boolean } {
  let patched = false;
  const nextRecentNodes = recentNodes.map(node => {
    if (node.id !== nodeId) return node;
    patched = true;
    return { ...node, summary };
  });
  return { recentNodes: nextRecentNodes, patched };
}

export interface AppState {
  // ── 问题 ──
  /** 问题树列表（按更新时间倒序排列） */
  roots: Root[];
  /** 侧边栏自定义分组 */
  rootGroups: RootGroup[];
  /** 当前打开的问题树 ID（null 表示未打开任何问题） */
  currentRootId: string | null;
  /** 当前问题树的树形结构（null 表示未加载） */
  rootTree: Node[] | null;
  /** 最近访问过的节点，按访问时间倒序 */
  recentNodes: Node[];

  // ── 聚焦 ──
  /** 当前聚焦（高亮/居中）的节点 ID */
  focusedNodeId: string | null;

  // ── 模型 ──
  /** 所有已配置的模型列表 */
  models: ModelConfig[];
  /** 用户已选择用于回答的模型 ID 列表（多选） */
  selectedModelIds: string[];
  /** 摘要使用的模型 ID；空字符串表示未选择 */
  summaryModelId: string;
  /** 是否自动为长问题和问题树生成摘要 */
  summaryAutoEnabled: boolean;

  // ── 视图状态 ──
  /** 每个节点的当前活跃模型 ID，nodeId → modelId */
  activeModelId: Record<string, string>;
  /** 折叠集合：父节点 ID 集合，折叠后隐藏其子节点 */
  collapsedSet: Set<string>;
  /** 沉浸式隐藏集合：隐藏某个父节点下的追问子节点（沉浸式阅读） */
  immersiveHiddenSet: Set<string>;
  /** 模型深度思考预算 {model_id: budget}，0=关闭深度思考 */
  thinkingBudgets: Record<string, number>;
  /** 联网搜索开关（持久于数据库 settings 表） */
  webSearchEnabled: boolean;
  /** 是否把用户全局 Profile 注入模型上下文 */
  profileInjectionEnabled: boolean;
  /** MinerU API Key 是否已配置（仅用于控制 PDF 上传入口状态） */
  mineruApiKeyConfigured: boolean;

  // ── 加载状态 ──
  /** 全局加载状态（打开问题树等） */
  loading: boolean;
  /** SSE 渐进式树加载中 */
  treeLoading: boolean;
  /** 消息发送中（含流式接收过程） */
  sendingMessage: boolean;
  /** 全局错误信息 */
  error: string | null;

  // ── 流式状态 ──
  /** 正在接收流式响应的节点 ID 集合（支持多节点同时流式） */
  streamingNodeIds: Set<string>;
  /** 流式节点的用户问题内容，nodeId → content */
  streamingContent: Record<string, string>;
  /** 流式模型响应映射 {nodeId:modelId → StreamingResponse}。多节点同时流式时通过 node_id 区分 */
  streamingResponses: Record<string, StreamingResponse>;
  /** 追问节点的 nut_id（后端 node_created 事件携带），用于 onDone 树补丁，nodeId → nutId */
  streamingNutId: Record<string, string | null>;
  /** 当前流式请求的关系类型（追问/推演），用于 ChatArea 区分渲染和滚动策略，nodeId → relation */
  streamingRelation: Record<string, 'followup' | 'progression' | null>;

  // ── 节点缓存 ──
  /** 会话级节点缓存（nodeId → Node），避免重复请求 */
  nodeCache: Record<string, Node>;

  /** 推演子节点创建后需要滚动到的节点 ID（不切换聚焦，仅滚动） */
  scrollToNodeId: string | null;
  /** 搜索结果定位目标：用于打开节点后滚动到命中词在原文中的位置 */
  searchScrollTarget: {
    nodeId: string;
    query: string;
    type: 'node' | 'response';
    modelId?: string;
    requestId: number;
  } | null;

  // ── UI 触发器 ──
  /** 递增以触发 InputBar 组件自动聚焦（每次 setState +1 触发 effect） */
  inputFocusTrigger: number;

  // ── Actions ──
  /** 获取问题树列表 */
  fetchRoots: () => Promise<void>;
  /** 新建侧边栏分组 */
  createRootGroup: (name: string) => Promise<void>;
  /** 更新侧边栏分组 */
  updateRootGroup: (groupId: string, data: Partial<RootGroup>) => Promise<void>;
  /** 删除侧边栏分组，组内问题树回到“对话” */
  deleteRootGroup: (groupId: string) => Promise<void>;
  /** 移动 root 到分组，不改变对话更新时间 */
  moveRootToGroup: (rootId: string, groupId: string | null) => Promise<void>;
  /** 获取最近访问过的节点 */
  fetchRecentNodes: () => Promise<void>;
  /** 记录最近访问节点：本地实时更新，异步持久化 */
  markRecentNode: (nodeId: string) => void;
  /** 清除 scrollToNodeId（滚动完成后由 ChatArea 调用） */
  clearScrollToNodeId: () => void;
  /** 设置/清除搜索结果定位目标 */
  setSearchScrollTarget: (target: Omit<NonNullable<AppState['searchScrollTarget']>, 'requestId'> | null) => void;
  clearSearchScrollTarget: () => void;
  /** 打开问题树（SSE 流式加载树，5 秒超时回退到 REST API） */
  openRoot: (rootId: string, opts?: { markRecent?: boolean }) => Promise<void>;
  /** 删除问题树（从列表移除；若当前问题树被删则回到 empty-state） */
  deleteRoot: (rootId: string) => Promise<void>;
  /** 聚焦节点（设置 focusedNodeId） */
  focusNode: (nodeId: string) => void;
  /** 切换节点折叠/展开 */
  toggleCollapse: (nodeId: string) => void;
  /** 折叠所有节点（遍历树中所有可折叠节点） */
  collapseAll: () => void;
  /** 将节点及所有后代设置为统一的折叠/展开状态 */
  setDescendantsCollapse: (nodeId: string, collapsed: boolean) => void;
  /** 切换沉浸式隐藏：隐藏/显示某父节点下的追问子节点 */
  toggleImmersive: (nodeId: string) => void;

  /**
   * 发送消息（流式聊天）
   *
   * 流程：
   * 1. 无问题树时自动创建问题
   * 2. 设置 pending 占位节点开始流式
   * 3. 通过 chatStream 逐 token 接收响应
   * 4. 流结束后调用 openRoot 刷新树
   *
   * @param opts.relation - 'followup'（追问）或 'progression'（递进推演）
   * @param opts.parentModelId - 追问模式下被追问的模型 ID
   */
  sendMessage: (content: string, opts: {
    rootId?: string;
    parentId?: string;
    nutId?: string;
    partialContent?: string;
    followupSeek?: number;
    followupEndSeek?: number;
    webSearch?: boolean;
    useProfile?: boolean;
    parentModelId?: string;
    modelIds?: string[];
    relation?: 'followup' | 'progression';
    attachments?: ImageAttachment[];
  }) => Promise<void>;

  /** 上传 PDF 并通过 MinerU 转成 Markdown response */
  importPdf: (file: File, opts: {
    rootId?: string;
    parentId?: string;
    relation?: 'followup' | 'progression';
    cardContent?: string;
  }) => Promise<void>;

  /** 直接提交 PDF 链接给 MinerU 并渲染 Markdown response */
  importPdfUrl: (url: string, opts: {
    filename?: string;
    rootId?: string;
    parentId?: string;
    relation?: 'followup' | 'progression';
    cardContent?: string;
  }) => Promise<void>;

  /** 上传 Markdown 文件并作为 Markdown response 渲染 */
  importMarkdown: (file: File, opts: {
    rootId?: string;
    parentId?: string;
    relation?: 'followup' | 'progression';
    cardContent?: string;
  }) => Promise<void>;

  /** 为指定节点向指定模型请求新响应（非流式，完成后刷新树） */
  requestNewResponse: (nodeId: string, modelId: string) => Promise<void>;

  /** 为已有节点追加一个新的模型回复（流式） */
  addModelToNode: (nodeId: string, modelId: string, thinkingBudget?: number, webSearch?: boolean) => Promise<void>;

  /**
   * 恢复流式输出 — 页面重载/重新打开时检测到有 streaming 中的响应时调用。
   * 连接 GET /api/chat/stream/{nodeId} 继续接收增量内容。
   */
  resumeStreaming: (nodeId: string) => Promise<void>;

  /** 获取模型列表并初始化 selectedModelIds / activeModelId */
  fetchModels: () => Promise<void>;
  /** 设置已选模型 ID 列表 */
  setSelectedModelIds: (ids: string[]) => void;
  /** 设置摘要模型；空字符串表示未选择 */
  setSummaryModelId: (id: string) => void;
  /** 切换是否自动生成摘要（手动生成不受影响） */
  setSummaryAutoEnabled: (enabled: boolean) => void;
  /** 设置某节点的活跃模型 tab */
  setActiveModelId: (nodeId: string, modelId: string) => void;
  /** 设置某个模型的深度思考预算值 */
  setThinkingBudget: (modelId: string, budget: number) => void;
  /** 切换联网搜索开关（同步写数据库） */
  setWebSearchEnabled: (enabled: boolean) => void;
  /** 切换 Profile 注入开关（同步写数据库） */
  setProfileInjectionEnabled: (enabled: boolean) => void;
  /** 从数据库加载联网搜索开关状态 */
  fetchWebSearchEnabled: () => Promise<void>;
  /**
   * 乐观删除模型：立即从本地移除 → 后台调用 API → 成功后验证刷新；失败则回滚
   * @throws API 调用失败时抛出异常，同时自动回滚状态
   */
  deleteModel: (modelId: string) => Promise<void>;
  /** 删除某个节点上的单条模型回复 */
  deleteResponse: (nodeId: string, responseId: string, modelId: string) => Promise<void>;
  /** 使用后端配置的摘要模型为节点生成摘要，并补丁到当前树 */
  generateNodeSummary: (nodeId: string, opts?: { force?: boolean }) => Promise<void>;

  // ── Helpers ──
  /** 从 rootTree 中查找节点从根到自身的路径链 */
  getNodePath: (nodeId: string) => Node[];
  /** 从 nodeCache 或 rootTree 中按 ID 查找节点 */
  getNodeById: (nodeId: string) => Node | null;
  /** 获取当前聚焦的节点（基于 focusedNodeId + getNodeById） */
  getFocusedNode: () => Node | null;
  /** 获取从指定节点出发的最深树路径上的 model 标识集合（"nodeId:modelId"） */
  getDeepestPathModels: (nodeId: string) => Set<string>;
  /** 清除全局错误信息 */
  clearError: () => void;

  // ── UI 操作 ──
  /** 触发 InputBar 聚焦（递增 inputFocusTrigger） */
  triggerInputFocus: () => void;
  /** 重置当前问题树状态 → empty-state */
  resetRoot: () => void;

  // ── Node 操作 ──
  /**
   * 删除节点（V3: 若删除的是问题根节点，后端返回 deleted_root=true，
   * 则同时清空问题树状态并刷新问题树列表）
   */
  deleteNode: (nodeId: string) => Promise<void>;
  /**
   * 重跑节点：重新向指定模型发送该节点的问题
   * @param newContent - 可选的新问题内容
   * @param modelIds - 可选的目标模型 ID 列表；未传时使用该节点已有回复模型
   */
  rerunNode: (nodeId: string, newContent?: string, modelIds?: string[]) => Promise<void>;

  // ── Helpers for streaming ──
  /** 获取指定 node 的流式响应子集（过滤 streamingResponses 组合键） */
  getNodeStreamingResponses: (nodeId: string) => Record<string, StreamingResponse>;
}

export const useAppStore = create<AppState>((set, get) => ({
  // ── 初始状态 ──
  roots: [],
  rootGroups: [],
  currentRootId: null,
  rootTree: null,
  recentNodes: [],
  focusedNodeId: null,
  models: [],
  selectedModelIds: [],
  summaryModelId: '',
  summaryAutoEnabled: false,
  activeModelId: {},
  collapsedSet: new Set(),
  immersiveHiddenSet: new Set(),
  thinkingBudgets: {},
  webSearchEnabled: false,
  profileInjectionEnabled: true,
  mineruApiKeyConfigured: false,
  loading: false,
  treeLoading: false,
  sendingMessage: false,
  error: null,
  streamingNodeIds: new Set<string>(),
  streamingContent: {},
  streamingResponses: {},
  streamingNutId: {},
  streamingRelation: {},
  nodeCache: {},
  scrollToNodeId: null,
  searchScrollTarget: null,
  inputFocusTrigger: 0,

  /** 获取问题树列表，替换全局 roots */
  fetchRoots: async () => {
    const [roots, rootGroups] = await Promise.all([
      api.listRoots(),
      api.listRootGroups(),
    ]);
    set({ roots, rootGroups });
  },

  createRootGroup: async (name: string) => {
    await api.createRootGroup({ name });
    const rootGroups = await api.listRootGroups();
    set({ rootGroups });
  },

  updateRootGroup: async (groupId: string, data: Partial<RootGroup>) => {
    const group = await api.updateRootGroup(groupId, data);
    set(state => ({
      rootGroups: state.rootGroups.map(g => g.id === groupId ? group : g),
    }));
  },

  deleteRootGroup: async (groupId: string) => {
    await api.deleteRootGroup(groupId);
    const [roots, rootGroups] = await Promise.all([
      api.listRoots(),
      api.listRootGroups(),
    ]);
    set({ roots, rootGroups });
  },

  moveRootToGroup: async (rootId: string, groupId: string | null) => {
    await api.moveRootToGroup(rootId, {
      group_id: groupId,
    });
    const roots = await api.listRoots();
    set({ roots });
  },

  fetchRecentNodes: async () => {
    const result = await api.getRecentNodes();
    set({ recentNodes: result.nodes || [] });
  },

  markRecentNode: (nodeId: string) => {
    const markedAt = Date.now();
    const commit = (node: Node) => {
      const remainingDelay = Math.max(0, RECENT_NODE_UPDATE_DELAY_MS - (Date.now() - markedAt));
      const existingTimer = recentNodeUpdateTimers.get(node.id);
      if (existingTimer) window.clearTimeout(existingTimer);

      const timer = window.setTimeout(() => {
        recentNodeUpdateTimers.delete(node.id);
        set(state => {
          const childCount = typeof node.child_count === 'number'
            ? node.child_count
            : countNodeDescendants(node);
          const followupQuote = getFollowupQuoteForNode(node, id => get().getNodeById(id) || get().nodeCache[id] || null);
          const recentNode = { ...node, child_count: childCount, followup_quote: followupQuote };
          const recentNodes = [
            recentNode,
            ...state.recentNodes.filter(n => n.id !== node.id),
          ].slice(0, RECENT_NODE_LIMIT);
          api.saveRecentNodes(recentNodes.map(n => n.id)).catch(err => {
            console.error('[recent-nodes] save failed:', err);
          });
          return { recentNodes };
        });
      }, remainingDelay);
      recentNodeUpdateTimers.set(node.id, timer);
    };

    const node = get().getNodeById(nodeId) || get().nodeCache[nodeId];
    if (node) {
      commit(node);
      return;
    }

    api.getNode(nodeId)
      .then(commit)
      .catch(err => console.error('[recent-nodes] load node failed:', err));
  },

  clearScrollToNodeId: () => set({ scrollToNodeId: null }),
  setSearchScrollTarget: (target) => set({
    searchScrollTarget: target ? { ...target, requestId: Date.now() } : null,
  }),
  clearSearchScrollTarget: () => set({ searchScrollTarget: null }),

  /**
   * 打开问题树，实现 SSE 流式加载 + 5 秒超时 REST 回退
   */
  openRoot: async (rootId: string, opts = {}) => {
    const shouldMarkRecent = opts.markRecent !== false;
    const hasCollapsePreference = hasCollapsedSetPreference(rootId);
    set({ loading: true, treeLoading: true });
    try {
      let rootReceived = false;

      // ── 安全超时：5 秒内未收到 root，回退到 REST API ──
      const fallbackTimer = setTimeout(async () => {
        if (!rootReceived) {
          console.warn('[openRoot] SSE 超时，回退到 REST API');
          try {
            const data = await api.getRootTree(rootId);
            const root = data.root || null;
            const tree = root ? [root] : [];
            // 填充 nodeCache
            const cache = { ...get().nodeCache };
            if (root) _populateCache(cache, root);
            const collapsedSet = !hasCollapsePreference && countTreeNodes(tree) > AUTO_COLLAPSE_NODE_THRESHOLD
              ? getAutoCollapsedSetForLargeTree(tree)
              : loadCollapsedSet(rootId);

            set({
              currentRootId: rootId,
              rootTree: tree,
              focusedNodeId: root?.id || null,
              loading: false,
              treeLoading: false,
              collapsedSet,
              immersiveHiddenSet: new Set(),
              nodeCache: cache,
            });
            _checkAndResumeStreaming(get());
            if (root && shouldMarkRecent) get().markRecentNode(root.id);
          } catch (e) {
            console.error('[openRoot] REST 回退也失败:', e);
            set({ loading: false, treeLoading: false });
          }
        }
      }, 5000);

      // ── 渐进式树加载（BFS SSE 流） ──
      await streamRootTree(rootId, {
        onRoot: (root) => {
          rootReceived = true;
          clearTimeout(fallbackTimer);
          const cache = { ...get().nodeCache };
          _populateCache(cache, root);
          set({
            currentRootId: rootId,
            rootTree: [root],
            focusedNodeId: root.id,
            collapsedSet: loadCollapsedSet(rootId),
            immersiveHiddenSet: new Set(),
            loading: false,
            nodeCache: cache,
          });
          if (shouldMarkRecent) get().markRecentNode(root.id);
        },
        onNode: (node) => {
          set(state => {
            if (!state.rootTree || !node.parent_id) return state;
            const newTree = JSON.parse(JSON.stringify(state.rootTree)) as Node[];
            const cache = { ...state.nodeCache };
            _populateCache(cache, node);

            const findAndAdd = (nodes: Node[]): boolean => {
              for (const n of nodes) {
                if (n.id === node.parent_id) {
                  if (!n.children) n.children = [];
                  if (!n.children.some(c => c.id === node.id)) {
                    n.children.push(node);
                  }
                  return true;
                }
                if (n.children?.length && findAndAdd(n.children)) return true;
              }
              return false;
            };
            if (!findAndAdd(newTree)) {
              console.warn('[openRoot] 无法挂载节点到父节点:', node.id, 'parent:', node.parent_id);
            }
            return { rootTree: newTree, nodeCache: cache };
          });
        },
        onDone: () => {
          clearTimeout(fallbackTimer);
          set(state => {
            if (
              !hasCollapsePreference &&
              state.rootTree &&
              state.collapsedSet.size === 0 &&
              countTreeNodes(state.rootTree) > AUTO_COLLAPSE_NODE_THRESHOLD
            ) {
              return {
                treeLoading: false,
                collapsedSet: getAutoCollapsedSetForLargeTree(state.rootTree),
              };
            }
            return { treeLoading: false };
          });
          _checkAndResumeStreaming(get());
        },
        onError: (err) => {
          clearTimeout(fallbackTimer);
          console.error('[openRoot] SSE 流错误:', err);
          if (!rootReceived) {
            api.getRootTree(rootId).then(data => {
              const root = data.root || null;
              const tree = root ? [root] : [];
              const cache = { ...get().nodeCache };
              if (root) _populateCache(cache, root);
              const collapsedSet = !hasCollapsePreference && countTreeNodes(tree) > AUTO_COLLAPSE_NODE_THRESHOLD
                ? getAutoCollapsedSetForLargeTree(tree)
                : loadCollapsedSet(rootId);
              set({
                currentRootId: rootId,
                rootTree: tree,
                focusedNodeId: root?.id || null,
                loading: false,
                treeLoading: false,
                collapsedSet,
                immersiveHiddenSet: new Set(),
                nodeCache: cache,
              });
              _checkAndResumeStreaming(get());
              if (root) get().markRecentNode(root.id);
            }).catch(() => {
              set({ loading: false, treeLoading: false, error: err });
            });
          } else {
            set({ loading: false, treeLoading: false, error: err });
          }
        },
      });
    } catch (e) {
      console.error('[openRoot] 异常:', e);
      set({ loading: false, treeLoading: false });
    }
  },

  /** 删除问题树 */
  deleteRoot: async (rootId: string) => {
    await api.deleteRoot(rootId);
    set(state => ({
      roots: state.roots.filter(t => t.id !== rootId),
      currentRootId: state.currentRootId === rootId ? null : state.currentRootId,
      rootTree: state.currentRootId === rootId ? null : state.rootTree,
      focusedNodeId: state.currentRootId === rootId ? null : state.focusedNodeId,
      recentNodes: (() => {
        const removedIds = state.recentNodes
          .filter(n => n.id === rootId || n.root_id === rootId)
          .map(n => n.id);
        clearRecentNodeTimers([rootId, ...removedIds]);
        const recentNodes = state.recentNodes.filter(n => n.id !== rootId && n.root_id !== rootId);
        if (recentNodes.length !== state.recentNodes.length) {
          api.saveRecentNodes(recentNodes.map(n => n.id)).catch(err => {
            console.error('[recent-nodes] save failed:', err);
          });
        }
        return recentNodes;
      })(),
    }));
  },

  /** 设置聚焦节点 */
  focusNode: (nodeId: string) => {
    set(state => {
      const collapsedSet = new Set(state.collapsedSet);
      collapsedSet.delete(nodeId);
      saveCollapsedSet(state.currentRootId, collapsedSet);
      return { focusedNodeId: nodeId, collapsedSet };
    });
    get().markRecentNode(nodeId);
  },

  /** 切换节点折叠/展开 */
  toggleCollapse: (nodeId: string) => {
    set(state => {
      const next = new Set(state.collapsedSet);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      saveCollapsedSet(state.currentRootId, next);
      return { collapsedSet: next };
    });
  },

  /** 全部折叠 */
  collapseAll: () => {
    const { rootTree, currentRootId } = get();
    if (!rootTree) return;
    const ids = new Set<string>();
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (canCollapseNode(n)) ids.add(n.id);
        if (n.children) walk(n.children);
      }
    };
    walk(rootTree);
    saveCollapsedSet(currentRootId, ids);
    set({ collapsedSet: ids });
  },

  /** 将节点及所有后代设置为统一的折叠/展开状态 */
  setDescendantsCollapse: (nodeId: string, collapsed: boolean) => {
    const { rootTree, currentRootId, collapsedSet } = get();
    if (!rootTree) return;
    const next = new Set(collapsedSet);

    // 找到目标节点并递归收集所有后代
    const collectDescendants = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        if (n.id === nodeId) {
          // 找到目标节点，递归收集所有后代
          const walk = (node: Node) => {
            if (canCollapseNode(node)) {
              if (collapsed) next.add(node.id);
              else next.delete(node.id);
            }
            if (node.children) {
              for (const child of node.children) walk(child);
            }
          };
          // 从目标节点的子节点开始遍历
          if (n.children) {
            for (const child of n.children) walk(child);
          }
          return true;
        }
        if (n.children && n.children.length > 0) {
          if (collectDescendants(n.children)) return true;
        }
      }
      return false;
    };
    collectDescendants(rootTree);

    saveCollapsedSet(currentRootId, next);
    set({ collapsedSet: next });
  },

  /** 切换沉浸式隐藏 */
  toggleImmersive: (nodeId: string) => {
    set(state => {
      const next = new Set(state.immersiveHiddenSet);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { immersiveHiddenSet: next };
    });
  },

  sendMessage: async (content, opts) => {
    const { selectedModelIds, thinkingBudgets, webSearchEnabled, profileInjectionEnabled } = get();
    if (!content.trim()) return;

    const useWebSearch = opts.webSearch !== undefined ? opts.webSearch : webSearchEnabled;
    const useProfile = opts.useProfile !== undefined ? opts.useProfile : profileInjectionEnabled;
    const requestedModelIds = opts.modelIds ?? selectedModelIds;
    const isLogicNode = requestedModelIds.length === 0;
    const nodeAttachments = opts.attachments || [];
    const nodeAttachmentsJson = JSON.stringify(nodeAttachments);

    const parentModelId = opts.parentId
      ? (opts.parentModelId || undefined)
      : undefined;

    const nonZeroBudgets: Record<string, number> = {};
    for (const [mid, budget] of Object.entries(thinkingBudgets)) {
      if (budget > 0) nonZeroBudgets[mid] = budget;
    }

    let rootId = opts.rootId || get().currentRootId;

    // ── 设置流式状态 ──
    const pendingNodeId = `pending-${Date.now()}`;
    const switchFocus = opts.relation === 'followup' || !opts.parentId;
    set(state => ({
      sendingMessage: true,
      streamingNodeIds: new Set([...state.streamingNodeIds, pendingNodeId]),
      streamingContent: { ...state.streamingContent, [pendingNodeId]: content },
      streamingNutId: { ...state.streamingNutId, [pendingNodeId]: null },
      streamingRelation: { ...state.streamingRelation, [pendingNodeId]: opts.relation || 'progression' },
      focusedNodeId: switchFocus ? pendingNodeId : (opts.parentId || pendingNodeId),
    }));

    try {
      await chatStream({
        content,
        root_id: rootId || undefined,
        parent_id: opts.parentId,
        model_ids: requestedModelIds,
        logic_node: isLogicNode,
        nut_id: opts.nutId,
        partial_content: opts.partialContent,
        followup_seek: opts.followupSeek,
        followup_end_seek: opts.followupEndSeek,
        web_search: useWebSearch,
        use_profile: useProfile,
        parent_model_id: parentModelId,
        relation: opts.relation,
        thinking_budgets: Object.keys(nonZeroBudgets).length > 0 ? nonZeroBudgets : undefined,
        attachments: opts.attachments,
      }, {
        onNodeCreated: (data) => {
          const nodeId = data.node_id;
          rootId = data.root_id;
          const relation = opts.relation || 'progression';
          set(prev => {
            const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
            patchNutIntoParentResponse(tree, opts.parentId, parentModelId, data.nut || null);

            if (opts.parentId) {
              const findAndAddChild = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === opts.parentId) {
                    if (!n.children) n.children = [];
                    if (!n.children.some((c: any) => c.id === nodeId)) {
                      n.children.push({
                        id: nodeId,
                        root_id: rootId,
                        parent_id: opts.parentId,
                        child_order: n.children.length,
                        content,
                        relation,
                        nut_id: data.nut_id || null,
                        parent_model_id: parentModelId || null,
                        search_enabled: null,
                        attachments: nodeAttachmentsJson,
                        summary: '',
                        pinned: 0,
                        archived: 0,
                        meta: isLogicNode ? JSON.stringify({ kind: 'logic' }) : '{}',
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        responses: [],
                        children: [],
                      });
                    }
                    return true;
                  }
                  if (n.children?.length && findAndAddChild(n.children)) return true;
                }
                return false;
              };
              findAndAddChild(tree);
            }

            // 更新深链接
            if (typeof window !== 'undefined' && (relation === 'followup' || !opts.parentId)) {
              window.history.pushState(null, '', '/node/' + nodeId);
            }

            // 更新 pending 到真实 nodeId
            const newSids = new Set(prev.streamingNodeIds);
            newSids.delete(pendingNodeId);
            newSids.add(nodeId);

            const contentMap = { ...prev.streamingContent };
            delete contentMap[pendingNodeId];
            contentMap[nodeId] = content;

            const nutIdMap = { ...prev.streamingNutId };
            delete nutIdMap[pendingNodeId];
            nutIdMap[nodeId] = data.nut_id || null;
            const relMap = { ...prev.streamingRelation };
            delete relMap[pendingNodeId];
            relMap[nodeId] = relation;

            return {
              streamingNodeIds: newSids,
              streamingContent: contentMap,
              streamingNutId: nutIdMap,
              streamingRelation: relMap,
              focusedNodeId: switchFocus ? nodeId : (opts.parentId || nodeId),
              scrollToNodeId: switchFocus ? null : nodeId,
              currentRootId: rootId || prev.currentRootId,
              rootTree: tree.length ? tree : prev.rootTree,
            };
          });

          if (relation === 'followup' || !opts.parentId) {
            get().markRecentNode(nodeId);
          }

          if (get().summaryAutoEnabled && estimateTextTokens(content) > 30) {
            get().generateNodeSummary(nodeId).catch(e => {
              console.error('[summary] generate node summary failed:', e);
            });
          }
        },
        onModelStart: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: {
                thinking: '',
                content: '',
                status: 'thinking',
                model_name: data.model_name,
              },
            },
          }));
        },
        onThinking: (data) => {
          const key = srKey(data.node_id, data.model_id);
          queueStreamingDelta(set, key, { thinking: data.content, status: 'thinking' });
        },
        onContent: (data) => {
          const key = srKey(data.node_id, data.model_id);
          queueStreamingDelta(set, key, { content: data.content, status: 'responding' });
        },
        onModelDone: (data) => {
          flushStreamingDeltas(set);
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            const models = bumpRecentModelUsage(
              state.models,
              data.model_id,
              (data.tokens_input || 0) + (data.tokens_output || 0),
            );
            if (!resp) return { models };
            return {
              models,
              streamingResponses: {
                ...state.streamingResponses,
                [key]: {
                  ...resp,
                  status: 'done',
                  response_id: data.response_id,
                  tokens_input: data.tokens_input,
                  tokens_output: data.tokens_output,
                  cost: data.cost,
                  latency_ms: data.latency_ms,
                },
              },
            };
          });
        },
        onModelError: (data) => {
          flushStreamingDeltas(set);
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: {
                thinking: '',
                content: '',
                status: 'error',
                error: data.error,
                model_name: data.model_name,
              },
            },
            error: `${data.model_name || data.model_id}: ${data.error}`,
          }));
        },
        onDone: async (data) => {
          flushStreamingDeltas(set);
          const nodeId = data.node_id || (get().streamingNodeIds.size > 0 ? [...get().streamingNodeIds][0] : null);
          if (nodeId && nodeId.startsWith('pending-')) {
            // wait for onNodeCreated to resolve the real nodeId
            // if done arrives before node_created (unlikely), just use as is
          }

          // ── 流式完成，将 streaming 结果补丁到问题树 ──
          const state = get();
          const streamContent = state.streamingContent[nodeId || ''] || '';

          // Build completed response list from streamingResponses
          const allSrs = state.streamingResponses;
          const newResponses: any[] = [];
          if (!isLogicNode && Object.keys(allSrs).length === 0) {
            console.warn('[onDone] streamingResponses is empty, skipping tree patch');
          }
          const completedModelIds: string[] = [];
          for (const [key, sr] of Object.entries(allSrs)) {
            // Only take responses for THIS node (match by nodeId prefix)
            if (nodeId && !key.startsWith(nodeId + ':')) continue;
            const mid = key.includes(':') ? key.split(':')[1] : key;
            if (!requestedModelIds.includes(mid)) continue;
            completedModelIds.push(mid);
            newResponses.push({
              id: (sr as any).response_id || `stream-${mid}`,
              node_id: nodeId!,
              model_id: mid,
              content: sr.content,
              status: sr.status === 'error' ? 'error' : 'completed',
              tokens_input: (sr as any).tokens_input || 0,
              tokens_output: (sr as any).tokens_output || 0,
              latency_ms: (sr as any).latency_ms || null,
              finish_reason: sr.status === 'error' ? 'error' : 'stop',
              sources: '[]',
              meta: sr.thinking ? JSON.stringify({ thinking_content: sr.thinking }) : '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              nuts: [],
              model_name: sr.model_name || mid,
            });
          }

          const nutId = (nodeId && state.streamingNutId[nodeId]) || null;
          const relation = (nodeId && state.streamingRelation[nodeId]) || 'progression';

          if (nodeId && rootId && state.currentRootId === rootId) {
            set(prev => {
              const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
              const newSids = new Set(prev.streamingNodeIds);

              if (opts.parentId) {
                const findAndAddChild = (nodes: any[]): boolean => {
                  for (const n of nodes) {
                    if (n.id === opts.parentId) {
                      if (!n.children) n.children = [];
                      if (!n.children.some((c: any) => c.id === nodeId)) {
                        n.children.push({
                          id: nodeId,
                          root_id: rootId,
                          parent_id: opts.parentId,
                          child_order: n.children.length,
                          content: streamContent,
                          relation,
                          nut_id: nutId,
                          parent_model_id: parentModelId || null,
                          search_enabled: null,
                          attachments: nodeAttachmentsJson,
                          summary: '',
                          pinned: 0,
                          archived: 0,
                          meta: isLogicNode ? JSON.stringify({ kind: 'logic' }) : '{}',
                          created_at: new Date().toISOString(),
                          updated_at: new Date().toISOString(),
                          responses: newResponses,
                          children: [],
                        });
                      } else {
                        const existing = n.children.find((c: any) => c.id === nodeId);
                        if (existing) {
                          if (newResponses.length > 0) {
                            existing.responses = mergeResponsesByModel(existing.responses, newResponses);
                          }
                          if (nutId) existing.nut_id = nutId;
                        }
                      }
                      return true;
                    }
                    if (n.children?.length && findAndAddChild(n.children)) return true;
                  }
                  return false;
                };
                findAndAddChild(tree);
              } else {
                const existingRoot = tree.find((n: any) => n.id === nodeId);
                if (existingRoot) {
                  if (newResponses.length > 0) {
                    existingRoot.responses = mergeResponsesByModel(existingRoot.responses, newResponses);
                  }
                } else {
                  tree.push({
                    id: nodeId,
                    root_id: rootId,
                    parent_id: null,
                    child_order: 0,
                    content: streamContent,
                    relation,
                    nut_id: null,
                    parent_model_id: null,
                    search_enabled: null,
                    attachments: nodeAttachmentsJson,
                    summary: '',
                    pinned: 0,
                    archived: 0,
                    meta: isLogicNode ? JSON.stringify({ kind: 'logic' }) : '{}',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    responses: newResponses,
                    children: [],
                  });
                }
              }

              const contentMap = { ...prev.streamingContent };
              const nutMap = { ...prev.streamingNutId };
              const relMap = { ...prev.streamingRelation };
              const nextStreamingResponses = nodeId
                ? removeStreamingResponseKeys(prev.streamingResponses, nodeId, completedModelIds)
                : prev.streamingResponses;
              if (nodeId && !hasNodeStreamingResponses(nextStreamingResponses, nodeId)) {
                newSids.delete(nodeId);
                delete contentMap[nodeId];
                delete nutMap[nodeId];
                delete relMap[nodeId];
              }

              return {
                rootTree: tree,
                focusedNodeId: (prev.focusedNodeId && prev.focusedNodeId.startsWith('pending-'))
                  ? nodeId
                  : prev.focusedNodeId,
                scrollToNodeId: null,
                sendingMessage: false,
                streamingNodeIds: newSids,
                streamingContent: contentMap,
                streamingResponses: nextStreamingResponses,
                streamingNutId: nutMap,
                streamingRelation: relMap,
              };
            });
          } else {
            set(prev => {
              const newSids = new Set(prev.streamingNodeIds);
              const contentMap = { ...prev.streamingContent };
              const nutMap = { ...prev.streamingNutId };
              const relMap = { ...prev.streamingRelation };
              const nextStreamingResponses = nodeId
                ? removeStreamingResponseKeys(prev.streamingResponses, nodeId, completedModelIds)
                : prev.streamingResponses;
              if (nodeId && !hasNodeStreamingResponses(nextStreamingResponses, nodeId)) {
                newSids.delete(nodeId);
                delete contentMap[nodeId];
                delete nutMap[nodeId];
                delete relMap[nodeId];
              }
              return {
                sendingMessage: false,
                streamingNodeIds: newSids,
                streamingContent: contentMap,
                streamingResponses: nextStreamingResponses,
                streamingNutId: nutMap,
                streamingRelation: relMap,
              };
            });
          }

          // 后台刷新问题树列表
          try { await get().fetchRoots(); } catch (e) { console.error('[stream] fetchRoots failed:', e); }
        },
      });
    } catch (e: any) {
      console.error('sendMessage error:', e);
      let msg = e?.message || String(e);
      if (msg === 'Failed to fetch') msg = tr('serverOffline', undefined, getLanguage());
      else if (msg.includes('NetworkError')) msg = tr('networkError', undefined, getLanguage());
      set(state => {
        const newSids = new Set(state.streamingNodeIds);
        newSids.delete(pendingNodeId);
        const contentMap = { ...state.streamingContent };
        const nutMap = { ...state.streamingNutId };
        const relMap = { ...state.streamingRelation };
        delete contentMap[pendingNodeId];
        delete nutMap[pendingNodeId];
        delete relMap[pendingNodeId];
        return {
          error: msg,
          sendingMessage: false,
          streamingNodeIds: newSids,
          streamingContent: contentMap,
          streamingResponses: state.streamingResponses,
          streamingNutId: nutMap,
          streamingRelation: relMap,
        };
      });
      throw e;
    }
  },

  importPdf: async (file, opts) => {
    const rootId = opts.rootId || get().currentRootId;
    const defaultContent = getLanguage() === 'en' ? `Read PDF: ${file.name}` : `阅读 PDF：${file.name}`;
    const content = opts.cardContent?.trim() || defaultContent;
    const modelId = 'mineru-pdf';
    const pendingNodeId = `pending-pdf-${Date.now()}`;
    const switchFocus = !opts.parentId;

    set(state => ({
      sendingMessage: true,
      streamingNodeIds: new Set([...state.streamingNodeIds, pendingNodeId]),
      streamingContent: { ...state.streamingContent, [pendingNodeId]: content },
      streamingNutId: { ...state.streamingNutId, [pendingNodeId]: null },
      streamingRelation: { ...state.streamingRelation, [pendingNodeId]: opts.relation || 'progression' },
      focusedNodeId: switchFocus ? pendingNodeId : (opts.parentId || pendingNodeId),
    }));

    let realNodeId = pendingNodeId;
    let realRootId = rootId || '';

    try {
      await importPdfStream({
        file,
        rootId: rootId || undefined,
        parentId: opts.parentId,
        relation: opts.relation || 'progression',
        cardContent: content,
      }, {
        onNodeCreated: (data) => {
          realNodeId = data.node_id;
          realRootId = data.root_id;
          set(prev => {
            const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
            const relation = opts.relation || 'progression';

            if (opts.parentId) {
              const findAndAddChild = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === opts.parentId) {
                    if (!n.children) n.children = [];
                    if (!n.children.some((c: any) => c.id === realNodeId)) {
                      n.children.push({
                        id: realNodeId,
                        root_id: realRootId,
                        parent_id: opts.parentId,
                        child_order: n.children.length,
                        content,
                        relation,
                        nut_id: null,
                        parent_model_id: modelId,
                        search_enabled: null,
                        attachments: '[]',
                        summary: '',
                        pinned: 0,
                        archived: 0,
                        meta: JSON.stringify({ kind: 'pdf_import', filename: file.name, source: 'mineru' }),
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        responses: [],
                        children: [],
                      });
                    }
                    return true;
                  }
                  if (n.children?.length && findAndAddChild(n.children)) return true;
                }
                return false;
              };
              findAndAddChild(tree);
            }

            if (typeof window !== 'undefined' && switchFocus) {
              window.history.pushState(null, '', '/node/' + realNodeId);
            }

            const newSids = new Set(prev.streamingNodeIds);
            newSids.delete(pendingNodeId);
            newSids.add(realNodeId);

            const contentMap = { ...prev.streamingContent };
            delete contentMap[pendingNodeId];
            contentMap[realNodeId] = content;

            const nutMap = { ...prev.streamingNutId };
            delete nutMap[pendingNodeId];
            nutMap[realNodeId] = null;

            const relMap = { ...prev.streamingRelation };
            delete relMap[pendingNodeId];
            relMap[realNodeId] = relation;

            return {
              streamingNodeIds: newSids,
              streamingContent: contentMap,
              streamingNutId: nutMap,
              streamingRelation: relMap,
              focusedNodeId: switchFocus ? realNodeId : (opts.parentId || realNodeId),
              scrollToNodeId: switchFocus ? null : realNodeId,
              currentRootId: realRootId || prev.currentRootId,
              rootTree: tree.length ? tree : prev.rootTree,
            };
          });
        },
        onModelStart: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'thinking', model_name: data.model_name },
            },
          }));
        },
        onThinking: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, thinking: resp.thinking + data.content, status: 'thinking' },
              },
            };
          });
        },
        onContent: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, content: resp.content + data.content, status: 'responding' },
              },
            };
          });
        },
        onModelDone: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: {
                  ...resp,
                  status: 'done',
                  response_id: data.response_id,
                  tokens_input: data.tokens_input || 0,
                  tokens_output: data.tokens_output || 0,
                  cost: data.cost || 0,
                  latency_ms: data.latency_ms,
                },
              },
            };
          });
        },
        onModelError: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'error', error: data.error, model_name: data.model_name },
            },
            error: `${data.model_name || data.model_id}: ${data.error}`,
          }));
        },
        onDone: async () => {
          const state = get();
          const key = srKey(realNodeId, modelId);
          const sr = state.streamingResponses[key];
          const fallbackResponses = sr ? [{
            id: (sr as any).response_id || `stream-${modelId}`,
            node_id: realNodeId,
            model_id: modelId,
            content: sr.content,
            status: sr.status === 'error' ? 'error' : 'completed',
            tokens_input: (sr as any).tokens_input || 0,
            tokens_output: (sr as any).tokens_output || 0,
            latency_ms: (sr as any).latency_ms || null,
            finish_reason: sr.status === 'error' ? 'error' : 'stop',
            sources: '[]',
            meta: sr.thinking ? JSON.stringify({ thinking_content: sr.thinking, source: 'mineru', filename: file.name }) : JSON.stringify({ source: 'mineru', filename: file.name }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            nuts: [],
            model_name: sr.model_name || 'MinerU PDF',
          }] : [];
          const newResponses = await loadNodeResponsesOrFallback(realNodeId, fallbackResponses, 'pdf-import');

          set(prev => {
            const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
            const relation = prev.streamingRelation[realNodeId] || opts.relation || 'progression';

            if (opts.parentId) {
              const patchChild = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === opts.parentId) {
                    const existing = n.children?.find((c: any) => c.id === realNodeId);
                    if (existing && newResponses.length > 0) {
                      existing.responses = mergeResponsesByModel(existing.responses, newResponses);
                    }
                    return true;
                  }
                  if (n.children?.length && patchChild(n.children)) return true;
                }
                return false;
              };
              patchChild(tree);
            } else {
              const existingRoot = tree.find((n: any) => n.id === realNodeId);
              if (existingRoot) {
                existingRoot.responses = mergeResponsesByModel(existingRoot.responses, newResponses);
              } else {
                tree.push({
                  id: realNodeId,
                  root_id: realRootId,
                  parent_id: null,
                  child_order: 0,
                  content,
                  relation,
                  nut_id: null,
                  parent_model_id: null,
                  search_enabled: null,
                  attachments: '[]',
                  summary: '',
                  pinned: 0,
                  archived: 0,
                  meta: JSON.stringify({ kind: 'pdf_import', filename: file.name, source: 'mineru' }),
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  responses: newResponses,
                  children: [],
                });
              }
            }

            const newSids = new Set(prev.streamingNodeIds);
            newSids.delete(realNodeId);
            const contentMap = { ...prev.streamingContent };
            const nutMap = { ...prev.streamingNutId };
            const relMap = { ...prev.streamingRelation };
            delete contentMap[realNodeId];
            delete nutMap[realNodeId];
            delete relMap[realNodeId];

            return {
              rootTree: tree,
              sendingMessage: false,
              streamingNodeIds: newSids,
              streamingContent: contentMap,
              streamingResponses: removeStreamingResponseKeys(prev.streamingResponses, realNodeId, [modelId]),
              streamingNutId: nutMap,
              streamingRelation: relMap,
              scrollToNodeId: null,
            };
          });

          try { await get().fetchRoots(); } catch (e) { console.error('[pdf-import] fetchRoots failed:', e); }
        },
      });
    } catch (e: any) {
      console.error('importPdf error:', e);
      let msg = e?.message || String(e);
      if (msg === 'Failed to fetch') msg = tr('serverOffline', undefined, getLanguage());
      set(state => {
        const newSids = new Set(state.streamingNodeIds);
        newSids.delete(pendingNodeId);
        newSids.delete(realNodeId);
        const contentMap = { ...state.streamingContent };
        const nutMap = { ...state.streamingNutId };
        const relMap = { ...state.streamingRelation };
        delete contentMap[pendingNodeId];
        delete contentMap[realNodeId];
        delete nutMap[pendingNodeId];
        delete nutMap[realNodeId];
        delete relMap[pendingNodeId];
        delete relMap[realNodeId];
        return {
          error: msg,
          sendingMessage: false,
          streamingNodeIds: newSids,
          streamingContent: contentMap,
          streamingResponses: removeNodeStreamingResponses(state.streamingResponses, realNodeId),
          streamingNutId: nutMap,
          streamingRelation: relMap,
        };
      });
      throw e;
    }
  },

  importPdfUrl: async (url, opts) => {
    const rootId = opts.rootId || get().currentRootId;
    let filename = (opts.filename || '').trim();
    if (!filename) {
      try {
        const parsed = new URL(url);
        filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'document.pdf');
      } catch {
        filename = 'document.pdf';
      }
    }
    if (!filename.toLowerCase().endsWith('.pdf')) filename = `${filename}.pdf`;
    const defaultContent = getLanguage() === 'en' ? `Read PDF: ${filename}` : `阅读 PDF：${filename}`;
    const content = opts.cardContent?.trim() || defaultContent;
    const modelId = 'mineru-pdf';
    const pendingNodeId = `pending-pdf-url-${Date.now()}`;
    const switchFocus = !opts.parentId;

    set(state => ({
      sendingMessage: true,
      streamingNodeIds: new Set([...state.streamingNodeIds, pendingNodeId]),
      streamingContent: { ...state.streamingContent, [pendingNodeId]: content },
      streamingNutId: { ...state.streamingNutId, [pendingNodeId]: null },
      streamingRelation: { ...state.streamingRelation, [pendingNodeId]: opts.relation || 'progression' },
      focusedNodeId: switchFocus ? pendingNodeId : (opts.parentId || pendingNodeId),
    }));

    let realNodeId = pendingNodeId;
    let realRootId = rootId || '';

    try {
      await importPdfUrlStream({
        url,
        filename,
        rootId: rootId || undefined,
        parentId: opts.parentId,
        relation: opts.relation || 'progression',
        cardContent: content,
      }, {
        onNodeCreated: (data) => {
          realNodeId = data.node_id;
          realRootId = data.root_id;
          set(prev => {
            const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
            const relation = opts.relation || 'progression';

            if (opts.parentId) {
              const findAndAddChild = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === opts.parentId) {
                    if (!n.children) n.children = [];
                    if (!n.children.some((c: any) => c.id === realNodeId)) {
                      n.children.push({
                        id: realNodeId,
                        root_id: realRootId,
                        parent_id: opts.parentId,
                        child_order: n.children.length,
                        content,
                        relation,
                        nut_id: null,
                        parent_model_id: modelId,
                        search_enabled: null,
                        attachments: '[]',
                        summary: '',
                        pinned: 0,
                        archived: 0,
                        meta: JSON.stringify({ kind: 'pdf_import', filename, source: 'mineru_url', source_url: url }),
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        responses: [],
                        children: [],
                      });
                    }
                    return true;
                  }
                  if (n.children?.length && findAndAddChild(n.children)) return true;
                }
                return false;
              };
              findAndAddChild(tree);
            }

            if (typeof window !== 'undefined' && switchFocus) {
              window.history.pushState(null, '', '/node/' + realNodeId);
            }

            const newSids = new Set(prev.streamingNodeIds);
            newSids.delete(pendingNodeId);
            newSids.add(realNodeId);

            const contentMap = { ...prev.streamingContent };
            delete contentMap[pendingNodeId];
            contentMap[realNodeId] = content;

            const nutMap = { ...prev.streamingNutId };
            delete nutMap[pendingNodeId];
            nutMap[realNodeId] = null;

            const relMap = { ...prev.streamingRelation };
            delete relMap[pendingNodeId];
            relMap[realNodeId] = relation;

            return {
              streamingNodeIds: newSids,
              streamingContent: contentMap,
              streamingNutId: nutMap,
              streamingRelation: relMap,
              focusedNodeId: switchFocus ? realNodeId : (opts.parentId || realNodeId),
              scrollToNodeId: switchFocus ? null : realNodeId,
              currentRootId: realRootId || prev.currentRootId,
              rootTree: tree.length ? tree : prev.rootTree,
            };
          });
        },
        onModelStart: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'thinking', model_name: data.model_name },
            },
          }));
        },
        onThinking: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, thinking: resp.thinking + data.content, status: 'thinking' },
              },
            };
          });
        },
        onContent: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, content: resp.content + data.content, status: 'responding' },
              },
            };
          });
        },
        onModelDone: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: {
                  ...resp,
                  status: 'done',
                  response_id: data.response_id,
                  tokens_input: data.tokens_input || 0,
                  tokens_output: data.tokens_output || 0,
                  cost: data.cost || 0,
                  latency_ms: data.latency_ms,
                },
              },
            };
          });
        },
        onModelError: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'error', error: data.error, model_name: data.model_name },
            },
            error: `${data.model_name || data.model_id}: ${data.error}`,
          }));
        },
        onDone: async () => {
          const state = get();
          const key = srKey(realNodeId, modelId);
          const sr = state.streamingResponses[key];
          const fallbackResponses = sr ? [{
            id: (sr as any).response_id || `stream-${modelId}`,
            node_id: realNodeId,
            model_id: modelId,
            content: sr.content,
            status: sr.status === 'error' ? 'error' : 'completed',
            tokens_input: (sr as any).tokens_input || 0,
            tokens_output: (sr as any).tokens_output || 0,
            latency_ms: (sr as any).latency_ms || null,
            finish_reason: sr.status === 'error' ? 'error' : 'stop',
            sources: '[]',
            meta: sr.thinking ? JSON.stringify({ thinking_content: sr.thinking, source: 'mineru_url', filename, source_url: url }) : JSON.stringify({ source: 'mineru_url', filename, source_url: url }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            nuts: [],
            model_name: sr.model_name || 'MinerU PDF',
          }] : [];
          const newResponses = await loadNodeResponsesOrFallback(realNodeId, fallbackResponses, 'pdf-url-import');

          set(prev => {
            const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
            const relation = prev.streamingRelation[realNodeId] || opts.relation || 'progression';

            if (opts.parentId) {
              const patchChild = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === opts.parentId) {
                    const existing = n.children?.find((c: any) => c.id === realNodeId);
                    if (existing && newResponses.length > 0) {
                      existing.responses = mergeResponsesByModel(existing.responses, newResponses);
                    }
                    return true;
                  }
                  if (n.children?.length && patchChild(n.children)) return true;
                }
                return false;
              };
              patchChild(tree);
            } else {
              const existingRoot = tree.find((n: any) => n.id === realNodeId);
              if (existingRoot) {
                existingRoot.responses = mergeResponsesByModel(existingRoot.responses, newResponses);
              } else {
                tree.push({
                  id: realNodeId,
                  root_id: realRootId,
                  parent_id: null,
                  child_order: 0,
                  content,
                  relation,
                  nut_id: null,
                  parent_model_id: null,
                  search_enabled: null,
                  attachments: '[]',
                  summary: '',
                  pinned: 0,
                  archived: 0,
                  meta: JSON.stringify({ kind: 'pdf_import', filename, source: 'mineru_url', source_url: url }),
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  responses: newResponses,
                  children: [],
                });
              }
            }

            const newSids = new Set(prev.streamingNodeIds);
            newSids.delete(realNodeId);
            const contentMap = { ...prev.streamingContent };
            const nutMap = { ...prev.streamingNutId };
            const relMap = { ...prev.streamingRelation };
            delete contentMap[realNodeId];
            delete nutMap[realNodeId];
            delete relMap[realNodeId];

            return {
              rootTree: tree,
              sendingMessage: false,
              streamingNodeIds: newSids,
              streamingContent: contentMap,
              streamingResponses: removeStreamingResponseKeys(prev.streamingResponses, realNodeId, [modelId]),
              streamingNutId: nutMap,
              streamingRelation: relMap,
              scrollToNodeId: null,
            };
          });

          try { await get().fetchRoots(); } catch (e) { console.error('[pdf-url-import] fetchRoots failed:', e); }
        },
      });
    } catch (e: any) {
      console.error('importPdfUrl error:', e);
      let msg = e?.message || String(e);
      if (msg === 'Failed to fetch') msg = tr('serverOffline', undefined, getLanguage());
      set(state => {
        const newSids = new Set(state.streamingNodeIds);
        newSids.delete(pendingNodeId);
        newSids.delete(realNodeId);
        const contentMap = { ...state.streamingContent };
        const nutMap = { ...state.streamingNutId };
        const relMap = { ...state.streamingRelation };
        delete contentMap[pendingNodeId];
        delete contentMap[realNodeId];
        delete nutMap[pendingNodeId];
        delete nutMap[realNodeId];
        delete relMap[pendingNodeId];
        delete relMap[realNodeId];
        return {
          error: msg,
          sendingMessage: false,
          streamingNodeIds: newSids,
          streamingContent: contentMap,
          streamingResponses: removeNodeStreamingResponses(state.streamingResponses, realNodeId),
          streamingNutId: nutMap,
          streamingRelation: relMap,
        };
      });
      throw e;
    }
  },

  importMarkdown: async (file, opts) => {
    const rootId = opts.rootId || get().currentRootId;
    const defaultContent = getLanguage() === 'en' ? `Read Markdown: ${file.name}` : `阅读 Markdown：${file.name}`;
    const content = opts.cardContent?.trim() || defaultContent;
    const modelId = 'markdown';
    const pendingNodeId = `pending-markdown-${Date.now()}`;
    const switchFocus = !opts.parentId;

    set(state => ({
      sendingMessage: true,
      streamingNodeIds: new Set([...state.streamingNodeIds, pendingNodeId]),
      streamingContent: { ...state.streamingContent, [pendingNodeId]: content },
      streamingNutId: { ...state.streamingNutId, [pendingNodeId]: null },
      streamingRelation: { ...state.streamingRelation, [pendingNodeId]: opts.relation || 'progression' },
      focusedNodeId: switchFocus ? pendingNodeId : (opts.parentId || pendingNodeId),
    }));

    let realNodeId = pendingNodeId;
    let realRootId = rootId || '';

    try {
      await importMarkdownStream({
        file,
        rootId: rootId || undefined,
        parentId: opts.parentId,
        relation: opts.relation || 'progression',
        cardContent: content,
      }, {
        onNodeCreated: (data) => {
          realNodeId = data.node_id;
          realRootId = data.root_id;
          set(prev => {
            const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
            const relation = opts.relation || 'progression';

            if (opts.parentId) {
              const findAndAddChild = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === opts.parentId) {
                    if (!n.children) n.children = [];
                    if (!n.children.some((c: any) => c.id === realNodeId)) {
                      n.children.push({
                        id: realNodeId,
                        root_id: realRootId,
                        parent_id: opts.parentId,
                        child_order: n.children.length,
                        content,
                        relation,
                        nut_id: null,
                        parent_model_id: modelId,
                        search_enabled: null,
                        attachments: '[]',
                        summary: '',
                        pinned: 0,
                        archived: 0,
                        meta: JSON.stringify({ kind: 'markdown_import', filename: file.name, source: 'upload', card_content: content }),
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        responses: [],
                        children: [],
                      });
                    }
                    return true;
                  }
                  if (n.children?.length && findAndAddChild(n.children)) return true;
                }
                return false;
              };
              findAndAddChild(tree);
            }

            if (typeof window !== 'undefined' && switchFocus) {
              window.history.pushState(null, '', '/node/' + realNodeId);
            }

            const newSids = new Set(prev.streamingNodeIds);
            newSids.delete(pendingNodeId);
            newSids.add(realNodeId);

            const contentMap = { ...prev.streamingContent };
            delete contentMap[pendingNodeId];
            contentMap[realNodeId] = content;

            const nutMap = { ...prev.streamingNutId };
            delete nutMap[pendingNodeId];
            nutMap[realNodeId] = null;

            const relMap = { ...prev.streamingRelation };
            delete relMap[pendingNodeId];
            relMap[realNodeId] = relation;

            return {
              streamingNodeIds: newSids,
              streamingContent: contentMap,
              streamingNutId: nutMap,
              streamingRelation: relMap,
              focusedNodeId: switchFocus ? realNodeId : (opts.parentId || realNodeId),
              scrollToNodeId: switchFocus ? null : realNodeId,
              currentRootId: realRootId || prev.currentRootId,
              rootTree: tree.length ? tree : prev.rootTree,
            };
          });
        },
        onModelStart: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'thinking', model_name: data.model_name },
            },
          }));
        },
        onThinking: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, thinking: resp.thinking + data.content, status: 'thinking' },
              },
            };
          });
        },
        onContent: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, content: resp.content + data.content, status: 'responding' },
              },
            };
          });
        },
        onModelDone: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: {
                  ...resp,
                  status: 'done',
                  response_id: data.response_id,
                  tokens_input: data.tokens_input || 0,
                  tokens_output: data.tokens_output || 0,
                  cost: data.cost || 0,
                  latency_ms: data.latency_ms,
                },
              },
            };
          });
        },
        onModelError: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'error', error: data.error, model_name: data.model_name },
            },
            error: `${data.model_name || data.model_id}: ${data.error}`,
          }));
        },
        onDone: async () => {
          const state = get();
          const key = srKey(realNodeId, modelId);
          const sr = state.streamingResponses[key];
          const fallbackResponses = sr ? [{
            id: (sr as any).response_id || `stream-${modelId}`,
            node_id: realNodeId,
            model_id: modelId,
            content: sr.content,
            status: sr.status === 'error' ? 'error' : 'completed',
            tokens_input: (sr as any).tokens_input || 0,
            tokens_output: (sr as any).tokens_output || 0,
            latency_ms: (sr as any).latency_ms || null,
            finish_reason: sr.status === 'error' ? 'error' : 'stop',
            sources: '[]',
            meta: sr.thinking ? JSON.stringify({ thinking_content: sr.thinking, source: 'upload', filename: file.name }) : JSON.stringify({ source: 'upload', filename: file.name }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            nuts: [],
            model_name: sr.model_name || 'markdown',
          }] : [];
          const newResponses = await loadNodeResponsesOrFallback(realNodeId, fallbackResponses, 'markdown-import');

          set(prev => {
            const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
            const relation = prev.streamingRelation[realNodeId] || opts.relation || 'progression';

            if (opts.parentId) {
              const patchChild = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === opts.parentId) {
                    const existing = n.children?.find((c: any) => c.id === realNodeId);
                    if (existing && newResponses.length > 0) {
                      existing.responses = mergeResponsesByModel(existing.responses, newResponses);
                    }
                    return true;
                  }
                  if (n.children?.length && patchChild(n.children)) return true;
                }
                return false;
              };
              patchChild(tree);
            } else {
              const existingRoot = tree.find((n: any) => n.id === realNodeId);
              if (existingRoot) {
                existingRoot.responses = mergeResponsesByModel(existingRoot.responses, newResponses);
              } else {
                tree.push({
                  id: realNodeId,
                  root_id: realRootId,
                  parent_id: null,
                  child_order: 0,
                  content,
                  relation,
                  nut_id: null,
                  parent_model_id: null,
                  search_enabled: null,
                  attachments: '[]',
                  summary: '',
                  pinned: 0,
                  archived: 0,
                  meta: JSON.stringify({ kind: 'markdown_import', filename: file.name, source: 'upload', card_content: content }),
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  responses: newResponses,
                  children: [],
                });
              }
            }

            const newSids = new Set(prev.streamingNodeIds);
            newSids.delete(realNodeId);
            const contentMap = { ...prev.streamingContent };
            const nutMap = { ...prev.streamingNutId };
            const relMap = { ...prev.streamingRelation };
            delete contentMap[realNodeId];
            delete nutMap[realNodeId];
            delete relMap[realNodeId];

            return {
              rootTree: tree,
              sendingMessage: false,
              streamingNodeIds: newSids,
              streamingContent: contentMap,
              streamingResponses: removeStreamingResponseKeys(prev.streamingResponses, realNodeId, [modelId]),
              streamingNutId: nutMap,
              streamingRelation: relMap,
              scrollToNodeId: null,
            };
          });

          try { await get().fetchRoots(); } catch (e) { console.error('[markdown-import] fetchRoots failed:', e); }
        },
      });
    } catch (e: any) {
      console.error('importMarkdown error:', e);
      let msg = e?.message || String(e);
      if (msg === 'Failed to fetch') msg = tr('serverOffline', undefined, getLanguage());
      set(state => {
        const newSids = new Set(state.streamingNodeIds);
        newSids.delete(pendingNodeId);
        newSids.delete(realNodeId);
        const contentMap = { ...state.streamingContent };
        const nutMap = { ...state.streamingNutId };
        const relMap = { ...state.streamingRelation };
        delete contentMap[pendingNodeId];
        delete contentMap[realNodeId];
        delete nutMap[pendingNodeId];
        delete nutMap[realNodeId];
        delete relMap[pendingNodeId];
        delete relMap[realNodeId];
        return {
          error: msg,
          sendingMessage: false,
          streamingNodeIds: newSids,
          streamingContent: contentMap,
          streamingResponses: removeNodeStreamingResponses(state.streamingResponses, realNodeId),
          streamingNutId: nutMap,
          streamingRelation: relMap,
        };
      });
      throw e;
    }
  },

  requestNewResponse: async (nodeId: string, modelId: string) => {
    const node = get().getNodeById(nodeId);
    if (!node) return;

    set({ sendingMessage: true });
    try {
      await api.chat({
        content: node.content,
        root_id: node.root_id,
        parent_id: node.parent_id || undefined,
        model_ids: [modelId],
      });
      const currentRootId = get().currentRootId;
      if (currentRootId) {
        await get().openRoot(currentRootId);
      }
    } catch (e) {
      console.error('requestNewResponse error:', e);
    } finally {
      set({ sendingMessage: false });
    }
  },

  addModelToNode: async (nodeId: string, modelId: string, thinkingBudget: number = 0, webSearch: boolean = false) => {
    const node = get().getNodeById(nodeId);
    if (!node) return;

    const key = srKey(nodeId, modelId);

    set(state => ({
      streamingNodeIds: new Set([...state.streamingNodeIds, nodeId]),
      streamingResponses: {
        ...state.streamingResponses,
        [key]: { thinking: '', content: '', status: 'thinking' as const },
      },
    }));

    try {
      await addModelStream(nodeId, { model_id: modelId, thinking_budget: thinkingBudget, web_search: webSearch }, {
        onModelStart: (data) => {
          const k = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [k]: { thinking: '', content: '', status: 'thinking' as const, model_name: data.model_name },
            },
          }));
        },
        onThinking: (data) => {
          const k = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[k];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [k]: { ...resp, thinking: resp.thinking + data.content, status: 'thinking' as const },
              },
            };
          });
        },
        onContent: (data) => {
          const k = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[k];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [k]: { ...resp, content: resp.content + data.content, status: 'responding' as const },
              },
            };
          });
        },
        onModelDone: (data) => {
          const k = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[k];
            const models = bumpRecentModelUsage(
              state.models,
              data.model_id,
              (data.tokens_input || 0) + (data.tokens_output || 0),
            );
            if (!resp) return { models };
            return {
              models,
              streamingResponses: {
                ...state.streamingResponses,
                [k]: { ...resp, status: 'done' as const, response_id: data.response_id,
                  tokens_input: data.tokens_input, tokens_output: data.tokens_output,
                  cost: data.cost, latency_ms: data.latency_ms },
              },
            };
          });
        },
        onModelError: (data) => {
          const k = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [k]: { thinking: '', content: '', status: 'error' as const, error: data.error },
            },
          }));
        },
        onDone: async (_data) => {
          // 将流式结果就地补丁到问题树（不调 openRoot，避免跨问题树闪回）
          const state = get();
          const sr = state.streamingResponses[key];

          if (sr && sr.status !== 'error') {
            const mid = modelId;

            const newResp: any = {
              id: (sr as any).response_id || `stream-${mid}`,
              node_id: nodeId,
              model_id: mid,
              content: sr.content,
              status: 'completed',
              tokens_input: (sr as any).tokens_input || 0,
              tokens_output: (sr as any).tokens_output || 0,
              latency_ms: (sr as any).latency_ms || null,
              finish_reason: 'stop',
              sources: '[]',
              meta: sr.thinking ? JSON.stringify({ thinking_content: sr.thinking }) : '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              nuts: [],
              model_name: sr.model_name || mid,
            };
            set(prev => {
              const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
              const findAndPatch = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === nodeId) {
                    if (!n.responses) n.responses = [];
                    // 替换同模型旧响应（如果有），否则追加
                    const existingIdx = n.responses.findIndex((r: any) => r.model_id === mid);
                    if (existingIdx >= 0) n.responses[existingIdx] = newResp;
                    else n.responses.push(newResp);
                    return true;
                  }
                  if (n.children?.length && findAndPatch(n.children)) return true;
                }
                return false;
              };
              findAndPatch(tree);
              return { rootTree: tree };
            });
          }

          // 只清理本次追加的模型，避免打断同一 NodeCard 上其它仍在流式的模型。
          set(state => {
            const resp = { ...state.streamingResponses };
            delete resp[key];
            const newSids = new Set(state.streamingNodeIds);
            if (!hasNodeStreamingResponses(resp, nodeId)) newSids.delete(nodeId);
            return { streamingResponses: resp, streamingNodeIds: newSids };
          });

          // 追加完成后，自动激活新加入的模型 chip
          get().setActiveModelId(nodeId, modelId);

          // 静默刷新问题树列表
          try { await get().fetchRoots(); } catch (e) { console.error('[addModel] fetchRoots failed:', e); }
        },
      });
    } catch (e) {
      console.error('addModelToNode error:', e);
      set(state => {
        const resp = { ...state.streamingResponses };
        delete resp[key];
        const newSids = new Set(state.streamingNodeIds);
        if (!hasNodeStreamingResponses(resp, nodeId)) newSids.delete(nodeId);
        return {
          streamingResponses: {
            ...resp,
            [key]: { thinking: '', content: '', status: 'error' as const, error: String(e) },
          },
          streamingNodeIds: newSids,
        };
      });
    }
  },

  /**
   * 恢复流式输出 — 页面重载/重新打开时调用。
   */
  resumeStreaming: async (nodeId: string) => {
    const node = get().getNodeById(nodeId);
    if (!node) return;

    set(state => ({
      sendingMessage: true,
      streamingNodeIds: new Set([...state.streamingNodeIds, nodeId]),
      streamingContent: { ...state.streamingContent, [nodeId]: node.content },
      streamingNutId: { ...state.streamingNutId, [nodeId]: null },
      focusedNodeId: nodeId,
    }));

    try {
      await reconnectChatStream(nodeId, {
        onModelStart: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'thinking', model_name: data.model_name },
            },
          }));
        },
        onThinking: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, thinking: resp.thinking + data.content, status: 'thinking' },
              },
            };
          });
        },
        onContent: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, content: resp.content + data.content, status: 'responding' },
              },
            };
          });
        },
        onModelDone: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            const models = bumpRecentModelUsage(
              state.models,
              data.model_id,
              (data.tokens_input || 0) + (data.tokens_output || 0),
            );
            if (!resp) return { models };
            return {
              models,
              streamingResponses: {
                ...state.streamingResponses,
                [key]: {
                  ...resp,
                  status: 'done',
                  response_id: data.response_id,
                  tokens_input: data.tokens_input,
                  tokens_output: data.tokens_output,
                  cost: data.cost,
                  latency_ms: data.latency_ms,
                },
              },
            };
          });
        },
        onModelError: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'error', error: data.error },
            },
          }));
        },
        onDone: async (data) => {
          // 将流式结果就地补丁到问题树（不调 openRoot，避免跨问题树闪回）
          const state = get();
          const newResponses: any[] = [];
          const allSrs = state.streamingResponses;
          for (const [k, sr] of Object.entries(allSrs)) {
            if (!k.startsWith(nodeId + ':')) continue;
            const mid = k.slice(nodeId.length + 1);
            newResponses.push({
              id: (sr as any).response_id || `stream-${mid}`,
              node_id: nodeId,
              model_id: mid,
              content: sr.content,
              status: sr.status === 'error' ? 'error' : 'completed',
              tokens_input: (sr as any).tokens_input || 0,
              tokens_output: (sr as any).tokens_output || 0,
              latency_ms: (sr as any).latency_ms || null,
              finish_reason: sr.status === 'error' ? 'error' : 'stop',
              sources: '[]',
              meta: sr.thinking ? JSON.stringify({ thinking_content: sr.thinking }) : '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              nuts: [],
              model_name: sr.model_name || mid,
            });
          }

          if (newResponses.length > 0) {
            set(prev => {
              const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
              const findAndPatch = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === nodeId) {
                    if (newResponses.length > 0) n.responses = newResponses;
                    return true;
                  }
                  if (n.children?.length && findAndPatch(n.children)) return true;
                }
                return false;
              };
              findAndPatch(tree);
              return { rootTree: tree };
            });
          }

          set(state => {
            const newSids = new Set(state.streamingNodeIds);
            newSids.delete(nodeId);
            const newCont = { ...state.streamingContent }; delete newCont[nodeId];
            const newNut = { ...state.streamingNutId }; delete newNut[nodeId];
            const newRel = { ...state.streamingRelation }; delete newRel[nodeId];
            return {
              sendingMessage: false,
              streamingNodeIds: newSids,
              streamingContent: newCont,
              streamingResponses: removeNodeStreamingResponses(state.streamingResponses, nodeId),
              streamingNutId: newNut,
              streamingRelation: newRel,
              error: null,
            };
          });

          // 静默刷新问题树列表
          try { await get().fetchRoots(); } catch (e) { console.error('[resume] fetchRoots failed:', e); }
        },
      });
    } catch (e: any) {
      console.error('resumeStreaming error:', e);
      set(state => {
        const newSids = new Set(state.streamingNodeIds); newSids.delete(nodeId);
        return {
          error: e?.message || String(e),
          sendingMessage: false,
          streamingNodeIds: newSids,
        };
      });
    }
  },

  /** 获取模型列表 */
  fetchModels: async () => {
    const { models, selected_model_ids, summary_model_id, summary_auto_enabled, thinking_budgets } = await api.listModels();
    set(state => {
      const validModelIds = new Set(models.filter(m => m.deleted !== 1).map(m => m.id));
      const currentValidSelection = state.selectedModelIds.filter(id => validModelIds.has(id));
      const nextSelectedModelIds = currentValidSelection.length > 0
        ? currentValidSelection
        : selected_model_ids.filter(id => validModelIds.has(id));
      const shouldPersistSelection =
        state.selectedModelIds.length !== nextSelectedModelIds.length ||
        state.selectedModelIds.some((id, idx) => id !== nextSelectedModelIds[idx]);

      if (shouldPersistSelection) {
        api.saveSettings({ selected_model_ids: JSON.stringify(nextSelectedModelIds) }).catch(err => {
          console.error('持久化 selectedModelIds 失败:', err);
        });
      }

      // 首次加载时用后端持久化的 thinking_budgets 初始化（仅当本地为空时）
      if (thinking_budgets && Object.keys(thinking_budgets).length > 0 && Object.keys(state.thinkingBudgets).length === 0) {
        return { models, selectedModelIds: nextSelectedModelIds, summaryModelId: summary_model_id || '', summaryAutoEnabled: summary_auto_enabled, thinkingBudgets: thinking_budgets };
      }
      return { models, selectedModelIds: nextSelectedModelIds, summaryModelId: summary_model_id || '', summaryAutoEnabled: summary_auto_enabled };
    });
  },

  setSelectedModelIds: (ids: string[]) => {
    const validModelIds = new Set(get().models.filter(m => m.deleted !== 1).map(m => m.id));
    const filteredIds = ids.filter(id => validModelIds.has(id));
    set({ selectedModelIds: filteredIds });
    // 持久化到后端，避免刷新网页后复位
    api.saveSettings({ selected_model_ids: JSON.stringify(filteredIds) }).catch(err => {
      console.error('持久化 selectedModelIds 失败:', err);
    });
  },

  setSummaryModelId: (id: string) => {
    const validModelIds = new Set(get().models.filter(m => m.deleted !== 1).map(m => m.id));
    const nextId = validModelIds.has(id) ? id : '';
    set({ summaryModelId: nextId });
    api.saveSettings({ summary_model_id: nextId }).catch(err => {
      console.error('持久化 summaryModelId 失败:', err);
    });
  },

  setSummaryAutoEnabled: (enabled: boolean) => {
    set({ summaryAutoEnabled: enabled });
    api.saveSettings({ summary_auto_enabled: String(enabled) }).catch(err => {
      console.error('持久化 summaryAutoEnabled 失败:', err);
    });
  },

  setActiveModelId: (nodeId: string, modelId: string) => {
    set(state => ({ activeModelId: { ...state.activeModelId, [nodeId]: modelId } }));
  },

  setThinkingBudget: (modelId: string, budget: number) => {
    set(state => {
      const newBudgets = { ...state.thinkingBudgets, [modelId]: budget };
      // 持久化到后端
      api.saveSettings({ thinking_budgets: JSON.stringify(newBudgets) }).catch(err => {
        console.error('持久化 thinkingBudgets 失败:', err);
      });
      return { thinkingBudgets: newBudgets };
    });
  },

  setWebSearchEnabled: async (enabled: boolean) => {
    set({ webSearchEnabled: enabled });
    api.saveSettings({ web_search_enabled: String(enabled) }).catch(() => {});
  },

  setProfileInjectionEnabled: async (enabled: boolean) => {
    set({ profileInjectionEnabled: enabled });
    api.saveSettings({ profile_injection_enabled: String(enabled) }).catch(() => {});
  },

  fetchWebSearchEnabled: async () => {
    try {
      const [settings, profile] = await Promise.all([
        api.getSettings(),
        api.getProfile(),
      ]);
      set({
        webSearchEnabled: settings.web_search_enabled === 'true',
        profileInjectionEnabled: profile.injection_enabled !== false,
        mineruApiKeyConfigured: Boolean(settings.mineru_api_key),
      });
    } catch {}
  },

  deleteModel: async (modelId: string) => {
    const prevModels = get().models;
    const prevSelected = get().selectedModelIds;
    const prevSummaryModelId = get().summaryModelId;
    const prevSummaryAutoEnabled = get().summaryAutoEnabled;
    // 乐观删除
    set(state => ({
      models: state.models.filter(m => m.id !== modelId),
      selectedModelIds: state.selectedModelIds.filter(id => id !== modelId),
      summaryModelId: state.summaryModelId === modelId ? '' : state.summaryModelId,
      summaryAutoEnabled: state.summaryModelId === modelId ? false : state.summaryAutoEnabled,
    }));
    try {
      await api.deleteModel(modelId);
    } catch (e) {
      // 回滚
      set({ models: prevModels, selectedModelIds: prevSelected, summaryModelId: prevSummaryModelId, summaryAutoEnabled: prevSummaryAutoEnabled });
      throw e;
    }
  },

  generateNodeSummary: async (nodeId: string, opts) => {
    if (!get().summaryModelId) return;
    const result = await api.generateSummary(nodeId, opts);
    if (!result.summary || result.disabled || result.skipped || result.updated === false) return;

    set(state => {
      const rootTree = state.rootTree ? JSON.parse(JSON.stringify(state.rootTree)) as Node[] : state.rootTree;
      let patched = false;
      if (rootTree) patched = patchNodeSummaryInTree(rootTree, nodeId, result.summary);

      const rootPatch = patchRootSummary(state.roots, nodeId, result.summary);
      if (rootPatch.patched) patched = true;

      const nodeCache = { ...state.nodeCache };
      if (nodeCache[nodeId]) {
        nodeCache[nodeId] = { ...nodeCache[nodeId], summary: result.summary };
        patched = true;
      }

      const recentPatch = patchRecentNodeSummary(state.recentNodes, nodeId, result.summary);
      if (recentPatch.patched) patched = true;

      return patched
        ? { rootTree, roots: rootPatch.roots, nodeCache, recentNodes: recentPatch.recentNodes }
        : {};
    });
  },

  deleteResponse: async (nodeId: string, responseId: string, modelId: string) => {
    const snapshot = {
      rootTree: get().rootTree,
      nodeCache: get().nodeCache,
      activeModelId: get().activeModelId,
      focusedNodeId: get().focusedNodeId,
    };

    set(state => {
      const patched = patchResponseRemoval(state.rootTree, state.nodeCache, nodeId, responseId);
      if (!patched.removed || !patched.node) return state;

      const activeModelId = { ...state.activeModelId };
      if (activeModelId[nodeId] === modelId) {
        const nextActive = patched.node.responses?.[0]?.model_id;
        if (nextActive) activeModelId[nodeId] = nextActive;
        else delete activeModelId[nodeId];
      }

      return {
        rootTree: patched.rootTree,
        nodeCache: patched.nodeCache,
        activeModelId,
      };
    });

    try {
      await api.deleteResponse(responseId);
    } catch (e) {
      set(snapshot);
      throw e;
    }
  },

  // ── Helpers ──

  getNodePath: (nodeId: string) => {
    const { rootTree } = get();
    if (!rootTree) return [];
    const path: Node[] = [];
    const idToNode = new Map<string, Node>();
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        idToNode.set(n.id, n);
        if (n.children) walk(n.children);
      }
    };
    walk(rootTree);
    let current = idToNode.get(nodeId);
    while (current) {
      path.unshift(current);
      current = current.parent_id ? idToNode.get(current.parent_id) : undefined;
    }
    return path;
  },

  getNodeById: (nodeId: string) => {
    // First check nodeCache
    const { nodeCache, rootTree } = get();
    if (nodeCache[nodeId]) return nodeCache[nodeId];

    // Then search rootTree
    if (!rootTree) return null;
    const queue = [...rootTree];
    while (queue.length > 0) {
      const n = queue.shift()!;
      if (n.id === nodeId) {
        // Populate cache
        set(state => ({ nodeCache: { ...state.nodeCache, [nodeId]: n } }));
        return n;
      }
      if (n.children) queue.push(...n.children);
    }
    return null;
  },

  getFocusedNode: () => {
    const { focusedNodeId } = get();
    return focusedNodeId ? get().getNodeById(focusedNodeId) : null;
  },

  getDeepestPathModels: (nodeId: string) => {
    const result = new Set<string>();
    const { rootTree } = get();
    const findNodeInTree = (nodes: Node[]): Node | null => {
      for (const n of nodes) {
        if (n.id === nodeId) return n;
        if (n.children?.length) {
          const found = findNodeInTree(n.children);
          if (found) return found;
        }
      }
      return null;
    };
    const node = rootTree ? findNodeInTree(rootTree) : get().getNodeById(nodeId);
    if (!node) return result;

    const depthCache = new Map<string, number>();
    const getSubtreeDepth = (n: Node): number => {
      const cached = depthCache.get(n.id);
      if (cached != null) return cached;
      if (!n.children?.length) return 0;
      const depth = 1 + Math.max(...n.children.map(getSubtreeDepth));
      depthCache.set(n.id, depth);
      return depth;
    };

    const getParentModelForChild = (parent: Node, child: Node): string | null => {
      if (child.parent_model_id) return child.parent_model_id;

      if (child.nut_id) {
        const sourceResponse = parent.responses?.find(response =>
          response.nuts?.some(nut => nut.id === child.nut_id)
        );
        if (sourceResponse) return sourceResponse.model_id;
      }

      return parent.responses?.length === 1 ? parent.responses[0].model_id : null;
    };

    const walkDeepestBranch = (n: Node) => {
      if (!n.children?.length) return;

      const maxDepth = Math.max(...n.children.map(getSubtreeDepth));
      for (const child of n.children) {
        if (getSubtreeDepth(child) !== maxDepth) continue;
        const parentModelId = getParentModelForChild(n, child);
        if (parentModelId) {
          result.add(`${n.id}:${parentModelId}`);
        }
        walkDeepestBranch(child);
      }
    };

    walkDeepestBranch(node);
    return result;
  },

  clearError: () => set({ error: null }),

  triggerInputFocus: () => set(state => ({ inputFocusTrigger: state.inputFocusTrigger + 1 })),

  resetRoot: () => set({
    currentRootId: null,
    rootTree: null,
    focusedNodeId: null,
    collapsedSet: new Set(),
    immersiveHiddenSet: new Set(),
    streamingNodeIds: new Set(),
    streamingContent: {},
    streamingResponses: {},
    streamingNutId: {},
    streamingRelation: {},
    nodeCache: {},
    searchScrollTarget: null,
  }),

  deleteNode: async (nodeId: string) => {
    try {
      const result = await api.deleteNode(nodeId);
      const deletedIds = new Set(result.deleted_ids?.length ? result.deleted_ids : [nodeId]);
      clearRecentNodeTimers(deletedIds);
      set(state => {
        const recentNodes = state.recentNodes.filter(n => !deletedIds.has(n.id));
        const nodeCache = { ...state.nodeCache };
        deletedIds.forEach(id => delete nodeCache[id]);
        if (recentNodes.length !== state.recentNodes.length) {
          api.saveRecentNodes(recentNodes.map(n => n.id)).catch(err => {
            console.error('[recent-nodes] save failed:', err);
          });
        }
        return {
          recentNodes,
          nodeCache,
          focusedNodeId: state.focusedNodeId && deletedIds.has(state.focusedNodeId) ? null : state.focusedNodeId,
        };
      });
      if (result.deleted_root) {
        set(state => ({
          roots: state.roots.filter(t => t.id !== result.root_id),
          currentRootId: null,
          rootTree: null,
          focusedNodeId: null,
        }));
        const roots = await api.listRoots();
        set({ roots });
      } else {
        const { currentRootId } = get();
        if (currentRootId) {
          await get().openRoot(currentRootId);
        }
      }
    } catch (e) {
      console.error('deleteNode error:', e);
      throw e;
    }
  },

  /** 重跑节点：重新向指定模型发送该节点的问题 */
  rerunNode: async (nodeId: string, newContent?: string, modelIds?: string[]) => {
    const { thinkingBudgets, webSearchEnabled, profileInjectionEnabled, models } = get();
    const activeModelIds = new Set(models.filter(m => m.deleted !== 1).map(m => m.id));
    const targetModelIds = (modelIds ?? (() => {
      const node = get().getNodeById(nodeId);
      return [...new Set((node?.responses || []).map(r => r.model_id).filter(Boolean))];
    })()).filter(id => activeModelIds.has(id));

    set(state => {
      let rootTree = state.rootTree;
      let nodeCache = state.nodeCache;

      // 编辑并重跑时，先乐观更新问题内容，避免等流式结束/刷新后卡片才变化。
      if (newContent !== undefined) {
        rootTree = state.rootTree ? JSON.parse(JSON.stringify(state.rootTree)) : state.rootTree;
        const patchContent = (nodes: Node[]): boolean => {
          for (const n of nodes) {
            if (n.id === nodeId) {
              n.content = newContent;
              return true;
            }
            if (n.children?.length && patchContent(n.children)) return true;
          }
          return false;
        };
        if (rootTree) patchContent(rootTree);

        nodeCache = { ...state.nodeCache };
        if (nodeCache[nodeId]) {
          nodeCache[nodeId] = { ...nodeCache[nodeId], content: newContent };
        }
      }

      return {
        rootTree,
        nodeCache,
        sendingMessage: true,
        streamingNodeIds: new Set([...state.streamingNodeIds, nodeId]),
        streamingContent: { ...state.streamingContent, [nodeId]: newContent || '' },
        streamingResponses: removeNodeStreamingResponses(state.streamingResponses, nodeId),
      };
    });

    try {
      await rerunNodeStream(nodeId, {
        content: newContent,
        model_ids: targetModelIds,
        thinking_budgets: Object.keys(thinkingBudgets).length > 0 ? thinkingBudgets : undefined,
        web_search: webSearchEnabled,
        use_profile: profileInjectionEnabled,
      }, {
        onNodeCreated: (data) => {
          // 使用真实 nodeId（rerun 时不会变）
        },
        onModelStart: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => ({
            streamingResponses: {
              ...state.streamingResponses,
              [key]: { thinking: '', content: '', status: 'thinking', model_name: data.model_name },
            },
          }));
        },
        onThinking: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, thinking: resp.thinking + data.content, status: 'thinking' },
              },
            };
          });
        },
        onContent: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, content: resp.content + data.content, status: 'responding' },
              },
            };
          });
        },
        onModelDone: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            const models = bumpRecentModelUsage(
              state.models,
              data.model_id,
              (data.tokens_input || 0) + (data.tokens_output || 0),
            );
            if (!resp) return { models };
            return {
              models,
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, status: 'done' },
              },
            };
          });
        },
        onModelError: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: {
                  thinking: resp?.thinking || '',
                  content: resp?.content || '',
                  status: 'error',
                  error: data.error,
                  model_name: data.model_name || resp?.model_name,
                },
              },
              error: data.error,
            };
          });
        },
        onSources: (data) => {
          const key = srKey(data.node_id, data.model_id);
          set(state => {
            const resp = state.streamingResponses[key];
            if (!resp) return state;
            return {
              streamingResponses: {
                ...state.streamingResponses,
                [key]: { ...resp, sources: data.sources },
              },
            };
          });
        },
        onDone: async (data) => {
          // 将流式结果就地补丁到问题树（不调 openRoot，避免跨问题树闪回）
          const nodeIdForPatch = nodeId;
          const state = get();
          const rootId = state.currentRootId;

          // 从 streamingResponses 构建新的 responses 列表
          const newResponses: any[] = [];
          const allSrs = state.streamingResponses;
          for (const [k, sr] of Object.entries(allSrs)) {
            if (!k.startsWith(nodeIdForPatch + ':')) continue;
            const mid = k.slice(nodeIdForPatch.length + 1);
            newResponses.push({
              id: (sr as any).response_id || `stream-${mid}`,
              node_id: nodeIdForPatch,
              model_id: mid,
              content: sr.content,
              status: sr.status === 'error' ? 'error' : 'completed',
              tokens_input: (sr as any).tokens_input || 0,
              tokens_output: (sr as any).tokens_output || 0,
              latency_ms: (sr as any).latency_ms || null,
              finish_reason: sr.status === 'error' ? 'error' : 'stop',
              sources: '[]',
              meta: sr.thinking ? JSON.stringify({ thinking_content: sr.thinking }) : '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              nuts: [],
              model_name: sr.model_name || mid,
            });
          }

          if (newResponses.length > 0) {
            set(prev => {
              const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
              const findAndPatch = (nodes: any[]): boolean => {
                for (const n of nodes) {
                  if (n.id === nodeIdForPatch) {
                    if (newResponses.length > 0) n.responses = newResponses;
                    return true;
                  }
                  if (n.children?.length && findAndPatch(n.children)) return true;
                }
                return false;
              };
              findAndPatch(tree);
              return { rootTree: tree };
            });
          }

          set(state => {
            const newSids = new Set(state.streamingNodeIds); newSids.delete(nodeId);
            const newCont = { ...state.streamingContent }; delete newCont[nodeId];
            return {
              sendingMessage: false,
              streamingNodeIds: newSids,
              streamingContent: newCont,
              streamingResponses: removeNodeStreamingResponses(state.streamingResponses, nodeId),
              error: null,
            };
          });

          // 静默刷新问题树列表
          try { await get().fetchRoots(); } catch (e) { console.error('[rerun] fetchRoots failed:', e); }
        },
      });
    } catch (e: any) {
      console.error('rerunNode error:', e);
      set(state => {
        const newSids = new Set(state.streamingNodeIds); newSids.delete(nodeId);
        return {
          error: e?.message || String(e),
          sendingMessage: false,
          streamingNodeIds: newSids,
        };
      });
    }
  },

  /** 获取指定 node 的流式响应子集 */
  getNodeStreamingResponses: (nodeId: string) => {
    return getNodeStreamingResponses(get().streamingResponses, nodeId);
  },
}));

/** 递归将节点及其子节点加入缓存 */
function _populateCache(cache: Record<string, Node>, node: Node) {
  cache[node.id] = node;
  if (node.children) {
    for (const child of node.children) {
      _populateCache(cache, child);
    }
  }
}

function patchResponseRemoval(
  rootTree: Node[] | null,
  nodeCache: Record<string, Node>,
  nodeId: string,
  responseId: string,
): {
  rootTree: Node[] | null;
  nodeCache: Record<string, Node>;
  node: Node | null;
  removed: boolean;
} {
  let removed = false;
  let patchedNode: Node | null = null;
  const patchNode = (node: Node): Node => {
    let next = node;
    if (node.id === nodeId) {
      const responses = node.responses || [];
      const nextResponses = responses.filter(r => r.id !== responseId);
      removed = nextResponses.length !== responses.length;
      if (removed) {
        next = { ...node, responses: nextResponses };
        patchedNode = next;
      }
    }

    if (next.children?.length) {
      let childrenChanged = false;
      const children = next.children.map(child => {
        const patchedChild = patchNode(child);
        if (patchedChild !== child) childrenChanged = true;
        return patchedChild;
      });
      if (childrenChanged) next = { ...next, children };
    }

    return next;
  };

  const nextRootTree = rootTree ? rootTree.map(patchNode) : rootTree;
  const cachedNode = nodeCache[nodeId];
  if (!removed && cachedNode) {
    const responses = cachedNode.responses || [];
    const nextResponses = responses.filter(r => r.id !== responseId);
    removed = nextResponses.length !== responses.length;
    if (removed) patchedNode = { ...cachedNode, responses: nextResponses };
  }

  if (!removed || !patchedNode) {
    return {
      rootTree,
      nodeCache,
      node: null,
      removed: false,
    };
  }

  return {
    rootTree: nextRootTree,
    nodeCache: { ...nodeCache, [nodeId]: patchedNode },
    node: patchedNode,
    removed: true,
  };
}
