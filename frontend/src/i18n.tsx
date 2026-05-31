import { useSyncExternalStore } from 'react';
import { api } from './api/client';

export type Language = 'zh-CN' | 'en';

const STORAGE_KEY = 'megaform-language';

export const LANGUAGES: Array<{ value: Language; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

const normalizeLanguage = (value?: string | null): Language => {
  if (!value) return 'zh-CN';
  const lower = value.toLowerCase();
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return 'zh-CN';
};

let currentLanguage: Language = normalizeLanguage(
  localStorage.getItem(STORAGE_KEY) || navigator.language,
);
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function setLanguage(language: Language, opts: { persistRemote?: boolean } = {}) {
  currentLanguage = normalizeLanguage(language);
  localStorage.setItem(STORAGE_KEY, currentLanguage);
  emit();
  if (opts.persistRemote) {
    api.updateLocale({ locale: currentLanguage }).catch(() => {});
  }
}

export function setLanguageFromLocale(locale?: string | null) {
  setLanguage(normalizeLanguage(locale), { persistRemote: false });
}

export function useLanguage() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLanguage,
    getLanguage,
  );
}

type Dict = Record<string, string>;

const zh: Dict = {
  loadingApp: '正在进入 MegaForm...',
  loginRequired: '请登录后继续。',
  language: '语言',
  email: '邮箱',
  displayNameOptional: '昵称（可选）',
  passwordMin: '密码，至少 8 位',
  processing: '处理中...',
  registerAndLogin: '注册并登录',
  emailLogin: '邮箱登录',
  goLogin: '已有账号？去登录',
  goRegister: '没有账号？注册一个',
  or: '或',
  googleLogin: '使用 Google 登录',
  browserKeepsLogin: '登录状态会保存在浏览器中。',
  authFailed: '认证失败',
  expandSidebar: '展开侧边栏',
  collapseSidebar: '折叠侧边栏',
  homePrompt: '我们应该用 MegaForm 探索什么？',
  newQuestion: '新问题',
  settings: '配置',
  searchChats: '搜索聊天记录...',
  searchResult: '搜索结果',
  pinned: '置顶',
  recent: '最近',
  archive: '归档',
  noChats: '暂无问题',
  focusQuestions: '专注问题',
  chats: '对话',
  justNow: '刚刚',
  minutesAgo: '{count}分钟前',
  hoursAgo: '{count}小时前',
  daysAgo: '{count}天前',
  monthsAgo: '{count}个月前',
  deleteRootConfirm: '确定删除这棵问题树？',
  summaryPlaceholder: '输入摘要...',
  editSummary: '编辑摘要',
  pin: '置顶',
  unpin: '取消置顶',
  delete: '删除',
  inputQuestion: '输入你的问题...',
  inputNewQuestion: '输入新的问题...',
  exploreBasedOn: '基于「{text}...」进一步探索...',
  thinkingDepth: '思考深度',
  chooseThinkingDepth: '点击选择思考深度',
  adjustThinkingDepth: '点击调整思考深度：{label}',
  disableThinking: '关闭深度思考',
  webSearch: '联网搜索',
  profileInjectOn: '本次默认注入 Profile',
  profileInjectOff: '本次默认不注入 Profile',
  send: '发送',
  inputTokens: '输入',
  outputTokens: '输出',
  thinkingProcess: '思考过程',
  lastResponseDeleteConfirm: '这已经是最后一个答复了，删除它会把整个节点删除，继续？',
  deletedModelTitle: '模型已删除，仍可查看历史回复',
  deepestPath: '最深探索路径',
  deleteModelResponse: '删除该模型回复',
  deleteModelResponseAria: '删除 {model} 的回复',
  addModelResponse: '追加模型回复',
  chooseModelAppend: '选择模型追加回复',
  webSearchEnabled: '已启用联网搜索',
  enableWebSearch: '启用联网搜索',
  off: '关',
  noThinking: '不思考',
  allModelsAdded: '所有模型已添加',
  askFollowup: '追问',
  followupFor: '针对「{text}」追问',
  followupPlaceholder: '输入追问内容...',
  close: '关闭',
  waitingModel: '正在等待模型响应...',
  clickExpand: '单击展开此卡片，双击展开子树',
  clickCollapse: '单击折叠此卡片，双击折叠子树',
  saveChanges: '保存修改',
  saveAndRerun: '↻ 保存并重跑',
  cancel: '取消',
  summaryCollapsedPlaceholder: '输入摘要（折叠时显示）',
  saveSummary: '✓ 保存摘要',
  focusNodeHint: '双击聚焦此节点',
  replies: '回复',
  immersiveBrowse: '沉浸式浏览：隐藏追问分支',
  nodeActions: '节点操作',
  addSummary: '添加摘要',
  editAndRerun: '编辑并重跑',
  editContent: '修改内容',
  rerunWithoutEdit: '重跑（不修改）',
  deleteNode: '删除节点',
  confirmDelete: '确认删除',
  confirmDeleteChildren: '确认删除（含 {count} 个子节点）',
  config: '配置',
  modelConfig: '模型配置',
  tokenUsage: 'Token 用量',
  onlineSearch: '联网搜索',
  account: '账户',
  autoSummary: '自动摘要',
  autoSummaryOff: '关闭自动摘要',
  autoSummaryNote1: '长问题自动写入节点摘要',
  autoSummaryNote2: '问题树浅层变更后安静 1 小时刷新',
  autoSummaryNote3: '每天凌晨自动全量检查',
  edit: '编辑',
  addModel: '+ 添加模型',
  chooseProvider: '选择模型供应商',
  custom: '自定义',
  back: '← 返回',
  backQuickConfig: '← 返回快速配置',
  chooseProviderModel: '选择 {provider} 模型',
  discoverModels: '发现模型',
  ollamaNoKey: 'Ollama 本地无需 API Key，直接点击发现',
  noModelsFound: '未发现任何模型，请检查 API Key 和网络连接',
  apiBadge: 'API',
  deepThinking: '深度思考',
  unknownPrice: '价格未知',
  free: '免费',
  added: '已添加',
  discoverHint: '输入 API Key 后点击「发现模型」获取可用模型列表，或直接从下方预设列表选择',
  configureModel: '配置 {provider} {model}',
  provider: '供应商',
  model: '模型',
  displayName: '显示名称',
  displayNamePlaceholder: '输入显示名称',
  displayNameHint: '可修改，太长的模型名可以简短些',
  apiUrl: 'API 地址',
  thinkingSupported: '支持（可在对话时选择思考深度）',
  price: '价格',
  priceInputOutput: '输入 {currency}{input} / 输出 {currency}{output} 每1M token',
  unknownPriceEditable: '价格未知（可稍后手动修改）',
  customModelConfig: '自定义模型配置',
  name: '名称',
  openaiCompatibleOther: 'OpenAI 兼容（其他）',
  inputPrice: '输入价格',
  outputPrice: '输出价格',
  currencyUnit: '货币单位',
  cny: '¥ 人民币 (CNY)',
  usd: '$ 美元 (USD)',
  save: '保存',
  loading: '加载中...',
  noData: '暂无数据',
  calls: '调用',
  totalToken: '总Token',
  cumulativeCost: '累计消费',
  actions: '操作',
  recalcUsage: '以当前定价重新计算消费',
  total: '合计',
  searchProvider: '搜索服务提供商',
  apiKeyPlaceholder: '输入 API Key',
  saveSearchConfig: '保存搜索配置',
  saving: '保存中...',
  saved: '已保存',
  notLoggedIn: '未登录',
  oauthLogin: 'OAuth 登录',
  localMode: '本地模式',
  loginStatus: '登录状态',
  localModeCopy: '当前使用免登录本地模式。切换到 OAuth 模式后，这里会显示 Google 账户与设备会话。',
  oauthModeCopy: '可以退出当前设备，或撤销此账户的所有设备会话。',
  bindSwitchGoogle: '绑定 / 切换 Google',
  clearLocalSession: '清除本机会话',
  logoutDevice: '退出当前设备',
  logoutAllDevices: '退出所有设备',
  saveLanguage: '保存语言',
  profileDefaultInject: '默认注入到模型上下文',
  updatedAt: '更新于 {time}',
  notSaved: '尚未保存',
  saveProfile: '保存 Profile',
  profileHistory: '版本历史',
  noProfileHistory: '暂无历史版本',
  manualSave: '手动保存',
  chars: '字符',
  restore: '恢复',
  restoreProfileConfirm: '确定恢复这个 Profile 历史版本？当前内容会另存为一个恢复版本。',
  quotePrefix: '引用',
  collapseAllNodes: '折叠全部节点',
  loadingTree: '⟳ 正在加载问题树...',
  startBelow: '✦ 在下方输入框开始对话',
  chooseQuestionStart: '选择一个问题开始',
  copyCode: '复制代码',
  serverOffline: '无法连接到服务器，请稍后重试',
  networkError: '网络连接失败，请检查服务器状态',
};

const en: Dict = {
  loadingApp: 'Entering MegaForm...',
  loginRequired: 'Sign in to continue.',
  language: 'Language',
  email: 'Email',
  displayNameOptional: 'Display name (optional)',
  passwordMin: 'Password, at least 8 characters',
  processing: 'Working...',
  registerAndLogin: 'Register and sign in',
  emailLogin: 'Sign in with email',
  goLogin: 'Already have an account? Sign in',
  goRegister: 'No account? Create one',
  or: 'or',
  googleLogin: 'Sign in with Google',
  browserKeepsLogin: 'Your sign-in is saved in this browser.',
  authFailed: 'Authentication failed',
  expandSidebar: 'Expand sidebar',
  collapseSidebar: 'Collapse sidebar',
  homePrompt: 'What should we explore with MegaForm?',
  newQuestion: 'New question',
  settings: 'Settings',
  searchChats: 'Search chats...',
  searchResult: 'Search result',
  pinned: 'Pinned',
  recent: 'Recent',
  archive: 'Archive',
  noChats: 'No questions yet',
  focusQuestions: 'Focused questions',
  chats: 'Chats',
  justNow: 'Just now',
  minutesAgo: '{count}m ago',
  hoursAgo: '{count}h ago',
  daysAgo: '{count}d ago',
  monthsAgo: '{count}mo ago',
  deleteRootConfirm: 'Delete this question tree?',
  summaryPlaceholder: 'Enter a summary...',
  editSummary: 'Edit summary',
  pin: 'Pin',
  unpin: 'Unpin',
  delete: 'Delete',
  inputQuestion: 'Ask a question...',
  inputNewQuestion: 'Ask a new question...',
  exploreBasedOn: 'Explore further from "{text}..."',
  thinkingDepth: 'Thinking depth',
  chooseThinkingDepth: 'Choose thinking depth',
  adjustThinkingDepth: 'Adjust thinking depth: {label}',
  disableThinking: 'Turn off deep thinking',
  webSearch: 'Web search',
  profileInjectOn: 'Profile is injected by default',
  profileInjectOff: 'Profile is not injected by default',
  send: 'Send',
  inputTokens: 'Input',
  outputTokens: 'Output',
  thinkingProcess: 'Thinking process',
  lastResponseDeleteConfirm: 'This is the last response. Deleting it will delete the whole node. Continue?',
  deletedModelTitle: 'This model was deleted; historical replies are still visible',
  deepestPath: 'Deepest exploration path',
  deleteModelResponse: 'Delete this model reply',
  deleteModelResponseAria: 'Delete {model} reply',
  addModelResponse: 'Add model reply',
  chooseModelAppend: 'Choose a model to add',
  webSearchEnabled: 'Web search enabled',
  enableWebSearch: 'Enable web search',
  off: 'Off',
  noThinking: 'No thinking',
  allModelsAdded: 'All models added',
  askFollowup: 'Follow up',
  followupFor: 'Follow up on "{text}"',
  followupPlaceholder: 'Enter a follow-up...',
  close: 'Close',
  waitingModel: 'Waiting for model response...',
  clickExpand: 'Click to expand this card; double-click to expand subtree',
  clickCollapse: 'Click to collapse this card; double-click to collapse subtree',
  saveChanges: 'Save changes',
  saveAndRerun: '↻ Save and rerun',
  cancel: 'Cancel',
  summaryCollapsedPlaceholder: 'Enter summary shown when collapsed',
  saveSummary: '✓ Save summary',
  focusNodeHint: 'Double-click to focus this node',
  replies: 'replies',
  immersiveBrowse: 'Immersive reading: hide follow-up branches',
  nodeActions: 'Node actions',
  addSummary: 'Add summary',
  editAndRerun: 'Edit and rerun',
  editContent: 'Edit content',
  rerunWithoutEdit: 'Rerun without edits',
  deleteNode: 'Delete node',
  confirmDelete: 'Confirm delete',
  confirmDeleteChildren: 'Confirm delete ({count} child nodes)',
  config: 'Settings',
  modelConfig: 'Models',
  tokenUsage: 'Token usage',
  onlineSearch: 'Web search',
  account: 'Account',
  autoSummary: 'Auto summary',
  autoSummaryOff: 'Disable auto summary',
  autoSummaryNote1: 'Long questions are summarized into nodes',
  autoSummaryNote2: 'Shallow tree changes refresh after 1 quiet hour',
  autoSummaryNote3: 'Full check runs every day before dawn',
  edit: 'Edit',
  addModel: '+ Add model',
  chooseProvider: 'Choose model provider',
  custom: 'Custom',
  back: '← Back',
  backQuickConfig: '← Back to quick setup',
  chooseProviderModel: 'Choose {provider} model',
  discoverModels: 'Discover models',
  ollamaNoKey: 'Ollama does not need an API key. Click discover directly.',
  noModelsFound: 'No models found. Check the API key and network.',
  apiBadge: 'API',
  deepThinking: 'Deep thinking',
  unknownPrice: 'Unknown price',
  free: 'Free',
  added: 'Added',
  discoverHint: 'Enter an API key and click "Discover models", or choose from the presets below.',
  configureModel: 'Configure {provider} {model}',
  provider: 'Provider',
  model: 'Model',
  displayName: 'Display name',
  displayNamePlaceholder: 'Enter display name',
  displayNameHint: 'You can shorten long model names.',
  apiUrl: 'API URL',
  thinkingSupported: 'Supported (choose thinking depth during chat)',
  price: 'Price',
  priceInputOutput: 'Input {currency}{input} / output {currency}{output} per 1M tokens',
  unknownPriceEditable: 'Unknown price (you can edit it later)',
  customModelConfig: 'Custom model config',
  name: 'Name',
  openaiCompatibleOther: 'OpenAI compatible (other)',
  inputPrice: 'Input price',
  outputPrice: 'Output price',
  currencyUnit: 'Currency',
  cny: '¥ CNY',
  usd: '$ USD',
  save: 'Save',
  loading: 'Loading...',
  noData: 'No data',
  calls: 'Calls',
  totalToken: 'Total tokens',
  cumulativeCost: 'Cost',
  actions: 'Actions',
  recalcUsage: 'Recalculate cost with current pricing',
  total: 'Total',
  searchProvider: 'Search provider',
  apiKeyPlaceholder: 'Enter API Key',
  saveSearchConfig: 'Save search config',
  saving: 'Saving...',
  saved: 'Saved',
  notLoggedIn: 'Not signed in',
  oauthLogin: 'OAuth login',
  localMode: 'Local mode',
  loginStatus: 'Login status',
  localModeCopy: 'You are using local mode. After switching to OAuth mode, Google accounts and device sessions appear here.',
  oauthModeCopy: 'You can sign out from this device or revoke all device sessions.',
  bindSwitchGoogle: 'Bind / switch Google',
  clearLocalSession: 'Clear local session',
  logoutDevice: 'Sign out this device',
  logoutAllDevices: 'Sign out all devices',
  saveLanguage: 'Save language',
  profileDefaultInject: 'Inject into model context by default',
  updatedAt: 'Updated {time}',
  notSaved: 'Not saved yet',
  saveProfile: 'Save Profile',
  profileHistory: 'Version history',
  noProfileHistory: 'No history yet',
  manualSave: 'Manual save',
  chars: 'chars',
  restore: 'Restore',
  restoreProfileConfirm: 'Restore this Profile version? Current content will be saved as a restore version.',
  quotePrefix: 'Quote',
  collapseAllNodes: 'Collapse all nodes',
  loadingTree: '⟳ Loading question tree...',
  startBelow: '✦ Start the conversation below',
  chooseQuestionStart: 'Choose a question to start',
  copyCode: 'Copy code',
  serverOffline: 'Cannot connect to the server. Please try again later.',
  networkError: 'Network connection failed. Check the server status.',
};

const dictionaries: Record<Language, Dict> = { 'zh-CN': zh, en };

export function tr(key: string, params?: Record<string, string | number>, language = currentLanguage): string {
  const template = dictionaries[language][key] || zh[key] || key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

export function useT() {
  const language = useLanguage();
  return (key: string, params?: Record<string, string | number>) => tr(key, params, language);
}

export function localizeThinkingLabel(label: string, language = currentLanguage) {
  if (language !== 'en') return label;
  const map: Record<string, string> = {
    低: 'Low',
    中: 'Medium',
    高: 'High',
    极简: 'Minimal',
    极致: 'Max',
    自适应: 'Adaptive',
    关: 'Off',
  };
  return map[label] || label;
}

export function localizeThinkingDescription(description: string, language = currentLanguage) {
  if (language !== 'en') return description;
  if (description.includes('默认') && description.includes('思考预算')) return description.replace('默认 ', 'Default ').replace(' 思考预算', ' thinking budget');
  if (description.includes('最低')) return description.replace('最低 ', 'Minimum ');
  if (description.includes('复杂任务推荐起点')) return 'Recommended starting point for complex tasks';
  if (description.includes('高强度思考预算')) return 'High-intensity thinking budget';
  if (description.includes('上限')) return description.replace(' 上限', ' limit');
  return description;
}

export function localizePresetText(text: string, language = currentLanguage) {
  if (language !== 'en') return text;
  const replacements: Array<[RegExp, string]> = [
    [/最新旗舰/g, 'latest flagship'],
    [/性价比推理/g, 'value reasoning'],
    [/性价比/g, 'value'],
    [/最便宜/g, 'cheapest'],
    [/1M 上下文/g, '1M context'],
    [/高性价比/g, 'high value'],
    [/旗舰/g, 'flagship'],
    [/均衡/g, 'balanced'],
    [/轻量/g, 'lightweight'],
    [/预览/g, 'preview'],
    [/推理/g, 'reasoning'],
    [/免费/g, 'free'],
    [/多模态/g, 'multimodal'],
    [/本地无需 Key/g, 'no key needed locally'],
    [/本地/g, 'local'],
    [/月之暗面/g, 'Moonshot'],
    [/通义千问/g, 'Qwen'],
    [/智谱 AI/g, 'Zhipu AI'],
    [/低/g, 'Low'],
    [/中/g, 'Medium'],
    [/高/g, 'High'],
    [/关/g, 'Off'],
  ];
  return replacements.reduce((next, [pattern, replacement]) => next.replace(pattern, replacement), text);
}

export function localizeSearchProviderText(text: string, language = currentLanguage) {
  if (language !== 'en') return text;
  return text
    .replace(/自托管/g, 'self-hosted')
    .replace(/注册即得 API Key/g, 'API key after signup')
    .replace(/无需 API Key, 填实例地址即可/g, 'No API key; enter instance URL')
    .replace(/完全免费/g, 'Free')
    .replace(/免费 \(self-hosted\)/g, 'Free (self-hosted)')
    .replace(/次\/月免费/g, ' free searches/month')
    .replace(/月起/g, '/month and up')
    .replace(/次/g, 'searches');
}
