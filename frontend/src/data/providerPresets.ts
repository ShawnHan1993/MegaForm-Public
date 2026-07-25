/**
 * MegaForm — 模型供应商预设
 * 提供快速接入能力：选择供应商后自动填充 URL、价格等，用户只需选模型+填 API Key
 *
 * 价格来源（2026-07 最新）：
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
      { model_name: 'gpt-5.5', name: 'GPT-5.5 (GPT 系列旗舰)', max_tokens: 16384, price_per_input: 0, price_per_output: 0, capabilities: { image_input: true } },
      {
        model_name: 'o3-pro', name: 'o3 Pro (o 系列旗舰)',
        max_tokens: 16384, price_per_input: 0.002, price_per_output: 0.008,
        capabilities: { image_input: true },
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
        model_name: 'claude-fable-5', name: 'Claude Fable 5 (最高能力)',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
        capabilities: { image_input: true },
        thinking: [{ label: '开', budget: 1, description: 'adaptive 思考' }],
      },
      {
        model_name: 'claude-opus-4-8', name: 'Claude Opus 4.8 (Opus 系列旗舰)',
        max_tokens: 16384, price_per_input: 0.005, price_per_output: 0.025,
        capabilities: { image_input: true },
        thinking: [
          { label: '开', budget: 1, description: 'adaptive 思考' },
        ],
      },
      {
        model_name: 'claude-sonnet-5', name: 'Claude Sonnet 5 (Sonnet 系列旗舰)',
        max_tokens: 16384, price_per_input: 0.003, price_per_output: 0.015,
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
        model_name: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Pro 系列旗舰)',
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
        model_name: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash (Flash 系列旗舰)',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
        capabilities: { image_input: true },
        thinking: [
          { label: '关', budget: 0, description: '不启用思考' },
          { label: '低', budget: 1024, description: '~1K thinkingBudget' },
          { label: '中', budget: 8192, description: '~8K thinkingBudget' },
          { label: '高', budget: 32768, description: '~32K thinkingBudget' },
        ],
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
        model_name: 'grok-4.5', name: 'Grok 4.5 (通用旗舰)',
        max_tokens: 16384, price_per_input: 0.00125, price_per_output: 0.0025,
        capabilities: { image_input: true },
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
      },
      {
        model_name: 'grok-4.20-multi-agent', name: 'Grok 4.20 Multi-Agent (研究旗舰)',
        max_tokens: 16384, price_per_input: 0.00125, price_per_output: 0.0025,
        capabilities: { image_input: true },
        thinking: [
          { label: '低', budget: 1024, description: '~1K 推理 token' },
          { label: '中', budget: 8192, description: '~8K 推理 token' },
          { label: '高', budget: 32768, description: '~32K 推理 token' },
        ],
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
        model_name: 'openai/gpt-5.5', name: 'OpenAI GPT-5.5',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
        capabilities: { image_input: true },
      },
      {
        model_name: 'anthropic/claude-fable-5', name: 'Claude Fable 5',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
        capabilities: { image_input: true },
      },
      {
        model_name: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8',
        max_tokens: 16384, price_per_input: 0.005, price_per_output: 0.025,
        capabilities: { image_input: true },
      },
      {
        model_name: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro',
        max_tokens: 16384, price_per_input: 0.002, price_per_output: 0.012,
        capabilities: { image_input: true },
      },
      {
        model_name: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
        capabilities: { image_input: true },
      },
      {
        model_name: 'x-ai/grok-4.5', name: 'Grok 4.5',
        max_tokens: 16384, price_per_input: 0.00125, price_per_output: 0.0025,
        capabilities: { image_input: true },
      },
      {
        model_name: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro',
        max_tokens: 16384, price_per_input: 0.000435, price_per_output: 0.00087,
      },
      {
        model_name: 'z-ai/glm-5.1', name: 'GLM-5.1',
        max_tokens: 32768, price_per_input: 0.00083, price_per_output: 0.00331,
      },
      {
        model_name: 'minimax/minimax-m2.7', name: 'MiniMax M2.7',
        max_tokens: 16384, price_per_input: 0.0003, price_per_output: 0.0012,
      },
      {
        model_name: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
        capabilities: { image_input: true },
      },
      {
        model_name: 'qwen/qwen3.7-max', name: 'Qwen3.7 Max',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
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
        model_name: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (旗舰)',
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
        model_name: 'glm-5.1', name: 'GLM-5.1 (文本旗舰)',
        max_tokens: 32768, price_per_input: 0.006, price_per_output: 0.024,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      {
        model_name: 'glm-5v-turbo', name: 'GLM-5V Turbo (多模态旗舰)',
        max_tokens: 32768, price_per_input: 0, price_per_output: 0,
        capabilities: { image_input: true },
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
        model_name: 'MiniMax-M2.7', name: 'MiniMax M2.7 (旗舰)',
        max_tokens: 16384, price_per_input: 0.00218, price_per_output: 0.0087,
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
      {
        model_name: 'kimi-k2.5', name: 'Kimi K2.5 (旗舰)',
        max_tokens: 16384, price_per_input: 0, price_per_output: 0,
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
    id: 'ollama',
    name: 'Ollama (本地)',
    logo: LOGO_OLLAMA,
    base_url: 'http://localhost:11434/v1',
    provider_type: 'ollama',
    api_key_hint: '(本地无需 Key)',
    currency: 'CNY',
    models: [
      { model_name: 'qwen3:235b', name: 'Qwen3 235B (Qwen 系列旗舰)', max_tokens: 16384, price_per_input: 0, price_per_output: 0 },
      { model_name: 'llama4:maverick', name: 'Llama 4 Maverick (Llama 系列旗舰)', max_tokens: 16384, price_per_input: 0, price_per_output: 0 },
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
        model_name: 'qwen3.7-max', name: 'Qwen3.7 Max (Max 系列旗舰)',
        max_tokens: 16384, price_per_input: 0.012, price_per_output: 0.036,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      {
        model_name: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus (Coder 系列旗舰)',
        max_tokens: 16384, price_per_input: 0.01, price_per_output: 0.04,
        thinking: [
          { label: '低', budget: 1024, description: '~1K 思考 token' },
          { label: '中', budget: 8192, description: '~8K 思考 token' },
          { label: '高', budget: 32768, description: '~32K 思考 token' },
        ],
      },
      {
        model_name: 'qwen3-omni-flash', name: 'Qwen3 Omni Flash (Omni 系列旗舰)',
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
