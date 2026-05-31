/**
 * 思考级别预设。
 *
 * 规则：
 * - 官方文档给出 effort / level / token budget 范围的，按对应 API 语义设档。
 * - 官方未明确说明强度控制方式的模型，统一使用 8K / 16K / 32K 三档。
 *
 * budget 值仍是前端统一传给后端的抽象值，后端按 provider/model_name 转译：
 * - OpenAI o3/o4: <=2K low, <=16K medium, >16K high
 * - DeepSeek: <=32K high, >32K max
 * - Gemini 3.x: <=4K LOW, >4K HIGH
 * - Gemini 2.5: thinkingBudget 整数
 * - Anthropic: budget_tokens 整数；Opus 4.7 由后端转为 adaptive
 * - 其他 OpenAI-compatible 供应商：若未做专用后端适配，budget 主要作为强度选择 UI
 */

export interface ThinkingLevel {
  label: string;
  budget: number;
  description: string;
}

export function getThinkingDepthClass(levels: ThinkingLevel[] | undefined, budget: number): string {
  if (!levels?.length || budget <= 0) return '';
  const sorted = [...levels].sort((a, b) => a.budget - b.budget);
  const index = sorted.findIndex(level => level.budget === budget);
  if (index < 0) return '';
  if (sorted.length === 1) return 'thinking-depth-1';

  const depth = Math.round((index / (sorted.length - 1)) * 3) + 1;
  return `thinking-depth-${depth}`;
}

const FALLBACK_LEVELS: ThinkingLevel[] = [
  { label: '8K', budget: 8192, description: '默认 8K 思考预算' },
  { label: '16K', budget: 16384, description: '默认 16K 思考预算' },
  { label: '32K', budget: 32768, description: '默认 32K 思考预算' },
];

const OPENAI_REASONING_LEVELS: ThinkingLevel[] = [
  { label: '低', budget: 2048, description: 'reasoning_effort=low' },
  { label: '中', budget: 16384, description: 'reasoning_effort=medium' },
  { label: '高', budget: 32768, description: 'reasoning_effort=high' },
];

const OPENAI_GPT5_LEVELS: ThinkingLevel[] = [
  { label: '极简', budget: 1024, description: 'reasoning_effort=minimal' },
  { label: '低', budget: 2048, description: 'reasoning_effort=low' },
  { label: '中', budget: 16384, description: 'reasoning_effort=medium' },
  { label: '高', budget: 32768, description: 'reasoning_effort=high' },
];

const ANTHROPIC_BUDGET_LEVELS: ThinkingLevel[] = [
  { label: '1K', budget: 1024, description: '最低 budget_tokens' },
  { label: '16K', budget: 16384, description: '复杂任务推荐起点' },
  { label: '32K', budget: 32768, description: '高强度思考预算' },
];

const GEMINI_3_LEVELS: ThinkingLevel[] = [
  { label: '低', budget: 4096, description: 'thinkingLevel=LOW' },
  { label: '高', budget: 32768, description: 'thinkingLevel=HIGH' },
];

const GEMINI_25_PRO_LEVELS: ThinkingLevel[] = [
  { label: '8K', budget: 8192, description: 'thinkingBudget=8192' },
  { label: '16K', budget: 16384, description: 'thinkingBudget=16384' },
  { label: '32K', budget: 32768, description: 'thinkingBudget=32768' },
];

const GEMINI_25_FLASH_LEVELS: ThinkingLevel[] = [
  { label: '低', budget: 1024, description: 'thinkingBudget=1024' },
  { label: '中', budget: 8192, description: 'thinkingBudget=8192' },
  { label: '高', budget: 24576, description: 'thinkingBudget=24576 上限' },
];

const DEEPSEEK_LEVELS: ThinkingLevel[] = [
  { label: '高', budget: 32768, description: 'reasoning_effort=high' },
  { label: '极致', budget: 65536, description: 'reasoning_effort=max' },
];

const XAI_REASONING_LEVELS: ThinkingLevel[] = [
  { label: '低', budget: 2048, description: 'reasoning_effort=low' },
  { label: '中', budget: 16384, description: 'reasoning_effort=medium' },
  { label: '高', budget: 32768, description: 'reasoning_effort=high' },
];

const QWEN_BUDGET_LEVELS: ThinkingLevel[] = [
  { label: '8K', budget: 8192, description: 'thinking_budget=8192' },
  { label: '16K', budget: 16384, description: 'thinking_budget=16384' },
  { label: '32K', budget: 32768, description: 'thinking_budget=32768' },
];

// provider → model_name/prefix → thinking levels
const THINKING_MAP: Record<string, Record<string, ThinkingLevel[]>> = {
  openai: {
    'gpt-5': OPENAI_GPT5_LEVELS,
    'o3': OPENAI_REASONING_LEVELS,
    'o4': OPENAI_REASONING_LEVELS,
  },

  anthropic: {
    'claude-opus-4-7': [
      { label: '自适应', budget: 1, description: 'thinking.type=adaptive' },
    ],
    'claude-opus-4': ANTHROPIC_BUDGET_LEVELS,
    'claude-sonnet-4': ANTHROPIC_BUDGET_LEVELS,
    'claude-haiku-4': ANTHROPIC_BUDGET_LEVELS,
  },

  gemini: {
    'gemini-3': GEMINI_3_LEVELS,
    'gemini-2.5-pro': GEMINI_25_PRO_LEVELS,
    'gemini-2.5-flash-lite': GEMINI_25_FLASH_LEVELS,
    'gemini-2.5-flash': GEMINI_25_FLASH_LEVELS,
  },

  deepseek: {
    'deepseek-v4': DEEPSEEK_LEVELS,
    'deepseek-reasoner': FALLBACK_LEVELS,
  },

  xai: {
    'grok-4': XAI_REASONING_LEVELS,
    'grok-3-mini': XAI_REASONING_LEVELS,
  },

  openrouter: {
    'openai/gpt-5': OPENAI_GPT5_LEVELS,
    'openai/o3': OPENAI_REASONING_LEVELS,
    'openai/o4': OPENAI_REASONING_LEVELS,
    'anthropic/claude-opus-4-7': [
      { label: '自适应', budget: 1, description: 'adaptive reasoning' },
    ],
    'anthropic/claude': ANTHROPIC_BUDGET_LEVELS,
    'google/gemini-3': GEMINI_3_LEVELS,
    'google/gemini-2.5-pro': GEMINI_25_PRO_LEVELS,
    'google/gemini-2.5-flash': GEMINI_25_FLASH_LEVELS,
    'deepseek/deepseek-v4': DEEPSEEK_LEVELS,
    'x-ai/grok-4': XAI_REASONING_LEVELS,
  },

  zhipu: {
    'glm-z1': FALLBACK_LEVELS,
    'glm-5': FALLBACK_LEVELS,
  },

  minimax: {
    'MiniMax-M1': FALLBACK_LEVELS,
  },

  kimi: {
    'kimi': FALLBACK_LEVELS,
    'moonshot': FALLBACK_LEVELS,
  },

  qwen: {
    'qwen3': QWEN_BUDGET_LEVELS,
  },

  ollama: {
    'qwen3': QWEN_BUDGET_LEVELS,
  },
};

function findLevelsInMap(pmap: Record<string, ThinkingLevel[]> | undefined, modelName: string): ThinkingLevel[] | undefined {
  if (!pmap) return undefined;
  if (pmap[modelName]) return pmap[modelName];

  const lowerModel = modelName.toLowerCase();
  for (const key of Object.keys(pmap)) {
    if (lowerModel.startsWith(key.toLowerCase())) return pmap[key];
  }
  return undefined;
}

/**
 * 根据 provider + model_name 查找思考级别预设。
 * OpenAI-compatible 供应商在保存时可能 provider=openai，因此如果 provider 内找不到，
 * 会再按 model_name 在所有供应商映射中全局匹配。
 */
export function getThinkingLevels(provider: string, modelName: string): ThinkingLevel[] {
  const byProvider = findLevelsInMap(THINKING_MAP[provider], modelName);
  if (byProvider) return byProvider;

  for (const pmap of Object.values(THINKING_MAP)) {
    const matched = findLevelsInMap(pmap, modelName);
    if (matched) return matched;
  }

  return FALLBACK_LEVELS;
}
