/**
 * MegaForm — 模型供应商预设
 * 提供快速接入能力：选择供应商后自动填充 URL、价格等，用户只需选模型+填 API Key
 *
 * 价格来源（2026-05 最新）：
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
 * - OpenAI: https://platform.openai.com/docs/pricing
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - Google Gemini: https://ai.google.dev/pricing
 * - xAI Grok: https://docs.x.ai/docs/pricing
 * - OpenRouter: https://openrouter.ai/models
 * - 智谱: https://open.bigmodel.cn/pricing
 * - MiniMax: https://platform.minimax.io/docs/guides/pricing-paygo
 * - Kimi: https://platform.moonshot.cn/docs/pricing
 *
 * 价格存储单位：price_per_input / price_per_output = 每 1K tokens
 * 中国供应商：人民币 (¥)，美国供应商：美元 ($)
 * 前端展示：×1000 = 每 1M tokens 价格
 * 汇率参考：1 USD ≈ 7.25 CNY
 */

export interface ThinkingLevel {
  label: string;
  budget: number;
  description: string;
}

export interface ModelPreset {
  model_name: string;
  name: string;
  max_tokens: number;
  price_per_input: number;
  price_per_output: number;
  thinking?: ThinkingLevel[];
  capabilities?: {
    image_input?: boolean;
  };
}

export interface ProviderPreset {
  id: string;
  name: string;
  logo: string;
  base_url: string;
  provider_type: string;
  api_key_hint: string;
  currency: string;            // 'USD' | 'CNY' — 价格货币单位
  models: ModelPreset[];
}

// ────────────────────────────────────────────
// 供应商 SVG Logo 路径
// ────────────────────────────────────────────

const ICON_BASE = '/provider-icons';
const LOGO_OPENAI = `${ICON_BASE}/openai.svg`;
const LOGO_ANTHROPIC = `${ICON_BASE}/anthropic.svg`;
const LOGO_GEMINI = `${ICON_BASE}/gemini.svg`;
const LOGO_XAI = `${ICON_BASE}/xai.svg`;
const LOGO_OPENROUTER = `${ICON_BASE}/openrouter.svg`;
const LOGO_DEEPSEEK = `${ICON_BASE}/deepseek.svg`;
const LOGO_ZHIPU = `${ICON_BASE}/zhipu.svg`;
const LOGO_MINIMAX = `${ICON_BASE}/minimax.svg`;
const LOGO_KIMI = `${ICON_BASE}/kimi.svg`;
const LOGO_OLLAMA = `${ICON_BASE}/ollama.svg`;
const LOGO_QWEN = `${ICON_BASE}/qwen.svg`;

// ────────────────────────────────────────────
// 供应商预设数据
// ────────────────────────────────────────────

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ═══ 美国供应商 — USD ═══
  {
    id: 'openai',
    name: 'OpenAI',
    logo: LOGO_OPENAI,
    base_url: 'https://api.openai.com/v1',
    provider_type: 'openai',
    api_key_hint: 'sk-...',
    currency: 'USD',
    models: [
      { model_name: 'gpt-5.5', name: 'GPT-5.5', max_tokens: 16384, price_per_input: 0, price_per_output: 0, capabilities: { image_input: true } },
      { model_name: 'gpt-5.2', name: 'GPT-5.2 (最新旗舰)', max_tokens: 16384, price_per_input: 0.00175, price_per_output: 0.014, capabilities: { image_input: true } },
      { model_name: 'gpt-5', name: 'GPT-5', max_tokens: 16384, price_per_input: 0.00125, price_per_output: 0.01, capabilities: { image_input: true } },
      { model_name: 'gpt-5-mini', name: 'GPT-5 Mini (性价比)', max_tokens: 16384, price_per_input: 0.00025, price_per_output: 0.002, capabilities: { image_input: true } },
      { model_name: 'gpt-5-nano', name: 'GPT-5 Nano (最便宜)', max_tokens: 16384, price_per_input: 0.00005, price_per_output: 0.0004, capabilities: { image_input: true } },
      { model_name: 'gpt-4.1', name: 'GPT-4.1 (1M 上下文)', max_tokens: 32768, price_per_input: 0.002, price_per_output: 0.008, capabilities: { image_input: true } },
      { model_name: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', max_tokens: 16384, price_per_input: 0.0004, price_per_output: 0.0016, capabilities: { image_input: true } },
      { model_name: 'gpt-4o', name: 'GPT-4o', max_tokens: 16384, price_per_input: 0.0025, price_per_output: 0.01, capabilities: { image_input: true } },
      { model_name: 'gpt-4o-mini', name: 'GPT-4o Mini', max_tokens: 16384, price_per_input: 0.00015, price_per_output: 0.0006, capabilities: { image_input: true } },
      {
        model_name: 'o3', name: 'o3 (推理)',
        max_tokens: 16384, price_per_input: 0.002, price_per_output: 0.008,
        capabilities: { image_input: true },
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
      {
        model_name: 'o4-mini', name: 'o4 Mini (性价比推理)',
        max_tokens: 16384, price_per_input: 0.0011, price_per_output: 0.0044,
        capabilities: { image_input: true },
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
      {
        model_name: 'o3-mini', name: 'o3 Mini',
        max_tokens: 16384, price_per_input: 0.0011, price_per_output: 0.0044,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    logo: LOGO_ANTHROPIC,
    base_url: 'https://api.anthropic.com',
    provider_type: 'anthropic',
    api_key_hint: 'sk-ant-...',
    currency: 'USD',
    models: [
      {
        model_name: 'claude-opus-4-7-20250514', name: 'Claude Opus 4.7 (旗舰)',
        max_tokens: 16384, price_per_input: 0.005, price_per_output: 0.025,
        capabilities: { image_input: true },
        thinking: [
          { label: '开', budget: 1, description: 'adaptive 思考' },
        ],
      },
      {
        model_name: 'claude-sonnet-4-6-20250514', name: 'Claude Sonnet 4.6 (均衡)',
        max_tokens: 16384, price_per_input: 0.003, price_per_output: 0.015,
        capabilities: { image_input: true },
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      {
        model_name: 'claude-haiku-4-5-20250514', name: 'Claude Haiku 4.5 (轻量)',
        max_tokens: 16384, price_per_input: 0.001, price_per_output: 0.005,
        capabilities: { image_input: true },
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    logo: LOGO_GEMINI,
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    provider_type: 'openai',
    api_key_hint: 'AIza...',
    currency: 'USD',
    models: [
      {
        model_name: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (预览)',
        max_tokens: 16384, price_per_input: 0.002, price_per_output: 0.012,
        capabilities: { image_input: true },
        thinking: [
          { label: '简洁', budget: 500, description: 'thinkingLevel=MINIMAL' },
          { label: '适中', budget: 2000, description: 'thinkingLevel=LOW' },
          { label: '深入', budget: 8000, description: 'thinkingLevel=MEDIUM' },
          { label: '极限', budget: 24000, description: 'thinkingLevel=HIGH' },
        ],
      },
      {
        model_name: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite (预览)',
        max_tokens: 16384, price_per_input: 0.00025, price_per_output: 0.0015,
        capabilities: { image_input: true },
      },
      {
        model_name: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro',
        max_tokens: 16384, price_per_input: 0.00125, price_per_output: 0.01,
        capabilities: { image_input: true },
        thinking: [
          { label: '低', budget: 1024, description: '~1K thinkingBudget (最小128)' },
          { label: '中', budget: 8192, description: '~8K thinkingBudget' },
          { label: '高', budget: 32768, description: '~32K thinkingBudget' },
        ],
      },
      {
        model_name: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash',
        max_tokens: 16384, price_per_input: 0.0003, price_per_output: 0.0025,
        capabilities: { image_input: true },
        thinking: [
          { label: '关', budget: 0, description: '不启用思考' },
          { label: '低', budget: 1024, description: '~1K thinkingBudget' },
          { label: '中', budget: 8192, description: '~8K thinkingBudget' },
          { label: '高', budget: 32768, description: '~32K thinkingBudget' },
        ],
      },
      {
        model_name: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite (高性价比)',
        max_tokens: 16384, price_per_input: 0.0001, price_per_output: 0.0004,
        capabilities: { image_input: true },
      },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    logo: LOGO_XAI,
    base_url: 'https://api.x.ai/v1',
    provider_type: 'openai',
    api_key_hint: 'xai-...',
    currency: 'USD',
    models: [
      {
        model_name: 'grok-4.1-fast', name: 'Grok 4.1 Fast (性价比推理)',
        max_tokens: 16384, price_per_input: 0.0002, price_per_output: 0.0005,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
      {
        model_name: 'grok-4', name: 'Grok 4 (旗舰)',
        max_tokens: 16384, price_per_input: 0.003, price_per_output: 0.015,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
      {
        model_name: 'grok-3-mini', name: 'Grok 3 Mini (轻量)',
        max_tokens: 16384, price_per_input: 0.0003, price_per_output: 0.0005,
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    logo: LOGO_OPENROUTER,
    base_url: 'https://openrouter.ai/api/v1',
    provider_type: 'openai',
    api_key_hint: 'sk-or-...',
    currency: 'USD',
    models: [
      {
        model_name: 'openai/gpt-5.2', name: 'OpenAI GPT-5.2',
        max_tokens: 16384, price_per_input: 0.00175, price_per_output: 0.014,
        capabilities: { image_input: true },
      },
      {
        model_name: 'openai/gpt-5', name: 'OpenAI GPT-5',
        max_tokens: 16384, price_per_input: 0.00125, price_per_output: 0.01,
        capabilities: { image_input: true },
      },
      {
        model_name: 'openai/gpt-5-mini', name: 'OpenAI GPT-5 Mini',
        max_tokens: 16384, price_per_input: 0.00025, price_per_output: 0.002,
        capabilities: { image_input: true },
      },
      {
        model_name: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6',
        max_tokens: 16384, price_per_input: 0.003, price_per_output: 0.015,
        capabilities: { image_input: true },
      },
      {
        model_name: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5',
        max_tokens: 16384, price_per_input: 0.001, price_per_output: 0.005,
        capabilities: { image_input: true },
      },
      {
        model_name: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro',
        max_tokens: 16384, price_per_input: 0.00125, price_per_output: 0.01,
        capabilities: { image_input: true },
      },
      {
        model_name: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash',
        max_tokens: 16384, price_per_input: 0.0003, price_per_output: 0.0025,
        capabilities: { image_input: true },
      },
      {
        model_name: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash',
        max_tokens: 16384, price_per_input: 0.00014, price_per_output: 0.00028,
      },
      {
        model_name: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro',
        max_tokens: 16384, price_per_input: 0.000435, price_per_output: 0.00087,
      },
      {
        model_name: 'x-ai/grok-4.1-fast', name: 'Grok 4.1 Fast',
        max_tokens: 16384, price_per_input: 0.0002, price_per_output: 0.0005,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
      {
        model_name: 'google/gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite',
        max_tokens: 16384, price_per_input: 0.0001, price_per_output: 0.0004,
        capabilities: { image_input: true },
      },
    ],
  },

  // ═══ 中国供应商 — CNY (¥) ═══
  {
    id: 'deepseek',
    name: 'DeepSeek',
    logo: LOGO_DEEPSEEK,
    base_url: 'https://api.deepseek.com/v1',
    provider_type: 'deepseek',
    api_key_hint: 'sk-...',
    currency: 'CNY',
    models: [
      {
        model_name: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash',
        max_tokens: 16384, price_per_input: 0.001015, price_per_output: 0.00203,
        thinking: [
          { label: '关', budget: 0, description: '非思考模式' },
          { label: '高', budget: 20000, description: 'reasoning_effort=high' },
          { label: '极致', budget: 60000, description: 'reasoning_effort=max' },
        ],
      },
      {
        model_name: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro',
        max_tokens: 16384, price_per_input: 0.00315, price_per_output: 0.00631,
        thinking: [
          { label: '高', budget: 20000, description: 'reasoning_effort=high' },
          { label: '极致', budget: 60000, description: 'reasoning_effort=max' },
        ],
      },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    logo: LOGO_ZHIPU,
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    provider_type: 'openai',
    api_key_hint: 'xxx.yyy (ID.Secret)',
    currency: 'CNY',
    models: [
      {
        model_name: 'glm-5.1', name: 'GLM-5.1',
        max_tokens: 32768, price_per_input: 0.006, price_per_output: 0.024,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      { model_name: 'glm-5-turbo', name: 'GLM-5 Turbo', max_tokens: 16384, price_per_input: 0.005, price_per_output: 0.022 },
      { model_name: 'glm-4.7', name: 'GLM-4.7', max_tokens: 16384, price_per_input: 0.002, price_per_output: 0.008 },
      { model_name: 'glm-4.7-flashx', name: 'GLM-4.7 FlashX', max_tokens: 16384, price_per_input: 0.0005, price_per_output: 0.003 },
      { model_name: 'glm-4.7-flash', name: 'GLM-4.7 Flash (免费)', max_tokens: 16384, price_per_input: 0, price_per_output: 0 },
      {
        model_name: 'glm-z1-flashx', name: 'GLM-Z1 FlashX (推理)',
        max_tokens: 16384, price_per_input: 0.0001, price_per_output: 0.0001,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    logo: LOGO_MINIMAX,
    base_url: 'https://api.minimax.chat/v1',
    provider_type: 'openai',
    api_key_hint: 'sk-...',
    currency: 'CNY',
    models: [
      {
        model_name: 'MiniMax-M2.7', name: 'MiniMax M2.7',
        max_tokens: 16384, price_per_input: 0.00218, price_per_output: 0.0087,
      },
      {
        model_name: 'MiniMax-M1', name: 'MiniMax M1 (推理)',
        max_tokens: 16384, price_per_input: 0.0029, price_per_output: 0.01595,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    logo: LOGO_KIMI,
    base_url: 'https://api.moonshot.cn/v1',
    provider_type: 'openai',
    api_key_hint: 'sk-...',
    currency: 'CNY',
    models: [
      { model_name: 'moonshot-v1-8k', name: 'Moonshot V1 8K', max_tokens: 8192, price_per_input: 0.002, price_per_output: 0.01 },
      { model_name: 'moonshot-v1-32k', name: 'Moonshot V1 32K', max_tokens: 32768, price_per_input: 0.005, price_per_output: 0.02 },
      { model_name: 'moonshot-v1-128k', name: 'Moonshot V1 128K', max_tokens: 131072, price_per_input: 0.01, price_per_output: 0.03 },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    logo: LOGO_OLLAMA,
    base_url: 'http://localhost:11434/v1',
    provider_type: 'ollama',
    api_key_hint: '(本地无需 Key)',
    currency: 'CNY',
    models: [
      { model_name: 'qwen3:8b', name: 'Qwen3 8B', max_tokens: 8192, price_per_input: 0, price_per_output: 0 },
      { model_name: 'llama3:8b', name: 'Llama3 8B', max_tokens: 8192, price_per_input: 0, price_per_output: 0 },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问 (Qwen)',
    logo: LOGO_QWEN,
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    provider_type: 'openai',
    api_key_hint: 'sk-...',
    currency: 'CNY',
    models: [
      {
        model_name: 'qwen3-max', name: 'Qwen3 Max (旗舰)',
        max_tokens: 16384, price_per_input: 0.04, price_per_output: 0.12,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      {
        model_name: 'qwen3-plus', name: 'Qwen3 Plus (均衡)',
        max_tokens: 16384, price_per_input: 0.008, price_per_output: 0.02,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      {
        model_name: 'qwen3-turbo', name: 'Qwen3 Turbo (轻量)',
        max_tokens: 16384, price_per_input: 0.003, price_per_output: 0.012,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      { model_name: 'qwen3-flash', name: 'Qwen3 Flash (免费)', max_tokens: 8192, price_per_input: 0, price_per_output: 0 },
      {
        model_name: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus',
        max_tokens: 16384, price_per_input: 0.01, price_per_output: 0.04,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      {
        model_name: 'qwen3-omni-flash', name: 'Qwen3 Omni Flash (多模态)',
        max_tokens: 8192, price_per_input: 0.0015, price_per_output: 0.006,
        capabilities: { image_input: true },
      },
    ],
  },
];

/**
 * 根据 provider + model_name 找到预设中的思考级别
 */
export function getThinkingLevels(providerType: string, modelName: string): ThinkingLevel[] | undefined {
  const provider = PROVIDER_PRESETS.find(p => p.id === providerType || p.provider_type === providerType);
  if (!provider) return undefined;
  const model = provider.models.find(m => m.model_name === modelName);
  return model?.thinking;
}

/**
 * 根据供应商 ID → 货币符号
 */
export function getCurrencySymbol(providerId: string): string {
  const provider = PROVIDER_PRESETS.find(p => p.id === providerId);
  if (!provider) return '¥';
  return provider.currency === 'USD' ? '$' : '¥';
}
