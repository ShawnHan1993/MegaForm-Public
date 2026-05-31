/**
 * MegaForm 前端类型定义
 * 与后端 database.py schema 对齐
 */

/** 节点（问题/追问/递进），构成问题树的基本单元 */
export interface Node {
  id: string;
  root_id: string;
  parent_id: string | null;        // 父节点 ID，null 表示根节点
  child_order: number;             // 在兄弟节点中的排序位置
  content: string;                 // 节点文本内容（用户输入的问题）
  relation: 'progression' | 'followup';  // 与父节点的关系：递进探索 / 追问
  nut_id: string | null;           // 指向父回复中被追问的 Nut（精选文本）ID
  parent_model_id: string | null;  // 追问时指定的父回复模型 ID
  search_enabled: number | null;   // 是否启用联网搜索 (0/1)
  attachments: string; // JSON string
  summary: string;      // 节点摘要（折叠时展示）
  pinned: number;       // 根节点是否置顶 (0/1)，普通节点通常为 0
  archived: number;     // 根节点是否归档 (0/1)，普通节点通常为 0
  meta: string;         // JSON string
  created_at: string;
  updated_at: string;
  // 从树 API join 来的关联数据
  responses?: Response[];
  children?: Node[];
}

/** 问题树根节点（列表接口附加 node_count） */
export type Root = Node & {
  pinned: number;
  archived: number;
  node_count?: number;
};

/** 模型回复 */
export interface Response {
  id: string;
  node_id: string;
  model_id: string;
  model_name?: string;   // 树 API 返回时附加，含已删除模型
  content: string;
  status: 'completed' | 'streaming' | 'error';
  tokens_input: number;
  tokens_output: number;
  latency_ms: number | null;
  finish_reason: string | null;
  thinking_budget?: number;  // 生成此回答时使用的思考强度
  sources: string;  // JSON string，引用来源
  meta: string;     // JSON string
  created_at: string;
  updated_at: string;
  nuts?: Nut[];     // 从树 API join 来的 Nuts（精选文本片段）
}

/** Nut（精选文本片段），标记回复中某一区间，用户可对该区间追问 */
export interface Nut {
  id: string;
  response_id: string;
  seek: number;        // 在回复内容中的起始字符偏移
  end_seek: number;    // 结束偏移（不包含）
  label: string | null;
  style: string | null;
  meta: string;
  created_at: string;
}

/** 模型配置（与后端 models 表对齐） */
export interface ModelConfig {
  id: string;
  name: string;           // 前端显示名
  provider: string;       // 供应商类型标识: openai / deepseek / ollama / anthropic / custom
  base_url: string | null;
  api_key: string | null;
  model_name: string;     // 模型标识（如 gpt-4o）
  max_tokens: number;
  thinking_budget: number;   // 思考深度预算（token 数，0=不启用）
  price_per_input: number;   // 输入价格（元/1K token 或 $/1K token）
  price_per_output: number;  // 输出价格
  price_unit: string;        // 货币单位 'CNY' | 'USD'
  deleted: number;           // 软删除标记 (0/1)
  meta: string;
  created_at: string;
  recent_usage_count?: number;  // 最近 2 天响应次数，用于输入栏排序
  recent_token_usage?: number;  // 最近 2 天 token 总量，用于排序兜底
}

/** Token 用量统计（按模型聚合） */
export interface TokenUsage {
  model_id: string;
  model_name: string;
  call_count: number;
  total_input: number;
  total_output: number;
  total_tokens: number;
  /** 累计实际消费金额（从 model_configs.usage 读取） */
  cumulative_usage: number;
  /** 货币单位: CNY=¥, USD=$ */
  price_unit: string;
  /** 软删除标记 (0=正常, 1=已删除) */
  deleted: number;
}

/** Token 用量查询响应 */
export interface TokenUsageResponse {
  models: TokenUsage[];
  totals: {
    call_count: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
    /** 累计消费总额 */
    cumulative_usage: number;
  };
}

export interface UserProfile {
  content: string;
  current_version_id: string | null;
  updated_at: string | null;
  injection_enabled: boolean;
}

export interface UserProfileVersion {
  id: string;
  user_id: string;
  content: string;
  note: string;
  created_at: string;
}

/** 聊天请求（发送给 /api/chat/stream） */
export interface ChatRequest {
  content: string;
  root_id?: string;
  parent_id?: string;               // 父节点 ID（追问/递进时指定）
  model_ids: string[];
  nut_id?: string;                  // 追问时指定被引用的 Nut ID
  partial_content?: string;         // 追问时传入的选中文本
  web_search?: boolean;
  parent_model_id?: string;         // 追问时指定父回复的模型 ID
  relation?: 'followup' | 'progression';
  logic_node?: boolean;             // 无模型时创建逻辑节点，不请求模型答复
  thinking_budgets?: Record<string, number>;  // {model_id: thinking_budget}
  use_profile?: boolean;            // 是否把用户全局 Profile 注入 system prompt
}

/** 单个模型返回结果 */
export interface ChatResult {
  model_id: string;
  model_name?: string;
  content?: string;
  tokens_input?: number;
  tokens_output?: number;
  cost?: number;
  latency_ms?: number;
  response_id?: string;
  error?: string;
}

/** 聊天响应（非流式） */
export interface ChatResponse {
  node_id: string;
  root_id: string;
  results: ChatResult[];
}

// ── 流式事件类型 ──

/** SSE 事件：节点已创建 */
export interface SSENodeCreated {
  root_id: string;
  node_id: string;
  nut_id?: string | null;
  nut?: Nut | null;        // 自动创建追问锚点时，后端同步返回完整 Nut，供前端热补丁父 response
  relation?: string;
}

/** SSE 事件：某个模型开始生成 */
export interface SSEModelStart {
  node_id: string;
  model_id: string;
  model_name: string;
}

/** SSE 事件：模型思考过程（深度思考模式） */
export interface SSEThinking {
  node_id: string;
  model_id: string;
  content: string;
}

/** SSE 事件：模型输出正文 */
export interface SSEContent {
  node_id: string;
  model_id: string;
  content: string;
}

/** SSE 事件：模型完成输出 */
export interface SSEModelDone {
  node_id: string;
  model_id: string;
  model_name: string;
  response_id: string;
  tokens_input: number;
  tokens_output: number;
  cost: number;
  latency_ms: number;
  thinking_budget?: number;
}

/** SSE 事件：模型输出错误 */
export interface SSEModelError {
  node_id: string;
  model_id: string;
  model_name?: string;
  error: string;
}

/** SSE 事件：原生搜索返回引用来源（如 Gemini Google Search grounding） */
export interface SSESources {
  node_id: string;
  model_id: string;
  sources: Array<{ title: string; url: string; snippet: string }>;
}

/** SSE 事件：流全部完成 */
export interface SSEDone {
  node_id: string;
}

/** 流式回调接口 — 由 client.ts 的 chatStream 调用 */
export interface StreamCallbacks {
  onNodeCreated?: (data: SSENodeCreated) => void;
  onModelStart?: (data: SSEModelStart) => void;
  onThinking?: (data: SSEThinking) => void;
  onContent?: (data: SSEContent) => void;
  onModelDone?: (data: SSEModelDone) => void;
  onModelError?: (data: SSEModelError) => void;
  onSources?: (data: SSESources) => void;
  onDone?: (data: SSEDone) => void;
}

/** 前端流式响应状态（非持久化，仅用于渲染） */
export interface StreamingResponse {
  thinking: string;     // 累积的思考过程文本
  content: string;      // 累积的正文输出
  status: 'thinking' | 'responding' | 'done' | 'error';
  error?: string;
  model_name?: string;
  sources?: Array<{ title: string; url: string; snippet: string }>;  // 原生搜索引用
}

/** 当前登录用户 */
export interface CurrentUser {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string;
  locale: string;
  timezone: string;
  last_login_at: string | null;
}

/** /api/me 响应 */
export interface MeResponse {
  authenticated: boolean;
  auth_mode: 'local' | 'oauth';
  local_mode: boolean;
  email_auth_enabled: boolean;
  google_auth_configured: boolean;
  user: CurrentUser | null;
}

export interface AuthResponse {
  status: string;
  user: CurrentUser;
}
