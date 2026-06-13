/**
 * ConfigModal — 模型配置管理弹窗
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 功能:
 *   - 已配置模型列表 (显示/设为默认/编辑/删除)
 *   - 快速配置: 选供应商 → 填 API Key → 自动发现模型 → 勾选添加
 *   - 自定义模式: 手动填写完整模型配置
 *   - Token 用量统计标签页
 *   - 深度思考 (thinking) 预算调节
 */

import { useState, useCallback, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import type { CurrentUser, ModelConfig, TokenUsage, UserProfileVersion } from '../types';
import { api } from '../api/client';
import { PROVIDER_PRESETS, getCurrencySymbol, type ProviderPreset, type ModelPreset } from '../data/providerPresets';
import { X, Search, AlertTriangle, Activity, CheckCircle2, RefreshCcw, Loader, User, LogOut, FileText, History, Bot, Image as ImageIcon } from 'lucide-react';
import { LANGUAGES, getLanguage, localizePresetText, localizeSearchProviderText, useLanguage, useT, type Language } from '../i18n';
import { modelPresetSupportsImageInput, modelSupportsImageInput, withImageInputCapability } from '../utils/multimodal';

interface Props {
  currentUser: CurrentUser | null;
  localMode: boolean;
  language: Language;
  onLanguageChange: (language: Language) => void;
  onLogout: (allDevices?: boolean) => void;
  onClose: () => void;
}

/** 合并后的模型条目 */
interface MergedModel {
  model_name: string;
  name: string;
  source: 'preset' | 'api' | 'both';
  price_per_input?: number;
  price_per_output?: number;
  max_tokens?: number;
  thinking?: ModelPreset['thinking'];
  capabilities?: ModelPreset['capabilities'];
  owned_by?: string;
}

/** 渲染供应商 SVG Logo */
function ProviderLogo({ logo, size = 24 }: { logo: string; size?: number }) {
  return (
    <span
      className="provider-logo"
      style={{ width: size, height: size, display: 'inline-flex', flexShrink: 0 }}
    >
      <img src={logo} alt="" aria-hidden="true" />
    </span>
  );
}

/** 供应商 Logo + 名称（紧凑模式，用于标题行） */
function ProviderLabel({ provider }: { provider: ProviderPreset }) {
  const language = useLanguage();
  return (
    <>
      <ProviderLogo logo={provider.logo} size={16} />
      {localizePresetText(provider.name, language)}
    </>
  );
}

const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible';
const CUSTOM_PROVIDER = 'custom';

const normalizeBaseUrl = (url?: string | null) => (url || '').trim().replace(/\/+$/, '').toLowerCase();
const getPriceCurrencySymbol = (priceUnit?: string | null) => priceUnit === 'USD' ? '$' : '￥';
const toPricePerMillionTokens = (price?: number | null) => (price ?? 0) * 1000;
const fromPricePerMillionTokens = (price?: string) => (parseFloat(price || '0') || 0) / 1000;

function findActualProviderPreset(model?: Partial<ModelConfig> | null): ProviderPreset | undefined {
  if (!model) return undefined;

  const baseUrl = normalizeBaseUrl(model.base_url);
  if (baseUrl) {
    const byBaseUrl = PROVIDER_PRESETS.find(p => normalizeBaseUrl(p.base_url) === baseUrl);
    if (byBaseUrl) return byBaseUrl;
  }

  const provider = model.provider || '';
  const byProviderId = PROVIDER_PRESETS.find(p => p.id === provider);
  if (byProviderId) return byProviderId;

  const modelName = model.model_name || '';
  if (modelName) {
    const byModelName = PROVIDER_PRESETS.find(p =>
      p.provider_type === provider && p.models.some(m => m.model_name === modelName)
    );
    if (byModelName) return byModelName;
  }

  return undefined;
}

function getProviderSelectValue(model?: Partial<ModelConfig> | null) {
  const preset = findActualProviderPreset(model);
  if (preset) return preset.id;
  if (model?.provider === 'openai') return OPENAI_COMPATIBLE_PROVIDER;
  return model?.provider || CUSTOM_PROVIDER;
}

function getProviderDisplayName(model: Partial<ModelConfig>) {
  const language = getLanguage();
  const preset = findActualProviderPreset(model);
  if (preset) return localizePresetText(preset.name, language);
  if (model.provider === 'openai') return language === 'en' ? 'OpenAI compatible' : 'OpenAI 兼容';
  if (model.provider === 'custom') return language === 'en' ? 'Custom' : '自定义';
  return model.provider || (language === 'en' ? 'Custom' : '自定义');
}

export default function ConfigModal({ currentUser, localMode, language, onLanguageChange, onLogout, onClose }: Props) {
  const activeLanguage = useLanguage();
  const t = useT();
  const models = useAppStore(s => s.models);
  // 过滤已删除的模型（deleted 为1表示标记为删除）
  const visibleModels = models.filter(m => m.deleted !== 1);
  const fetchModels = useAppStore(s => s.fetchModels);
  const deleteModel = useAppStore(s => s.deleteModel);
  const summaryModelId = useAppStore(s => s.summaryModelId);
  const summaryAutoEnabled = useAppStore(s => s.summaryAutoEnabled);
  const setSummaryModelId = useAppStore(s => s.setSummaryModelId);
  const setSummaryAutoEnabled = useAppStore(s => s.setSummaryAutoEnabled);
  const setProfileInjectionEnabledStore = useAppStore(s => s.setProfileInjectionEnabled);
  const refreshServiceSettings = useAppStore(s => s.fetchWebSearchEnabled);
  const [editingModel, setEditingModel] = useState<Partial<ModelConfig> | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [activeTab, setActiveTab] = useState<'models' | 'usage' | 'search' | 'mineru' | 'account'>('models');

  // ━━━ 搜索配置状态 ━━━
  interface SearchProvider { id: string; name: string; base_url: string; api_key_hint: string; free_tier: string; pricing: string; }
  const [searchProviders, setSearchProviders] = useState<SearchProvider[]>([]);
  const [searchProvider, setSearchProvider] = useState('');
  const [searchApiKey, setSearchApiKey] = useState('');
  const [searchBaseUrl, setSearchBaseUrl] = useState('');
  const [searchSaving, setSearchSaving] = useState(false);
  const [searchSaved, setSearchSaved] = useState(false);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [mineruLoaded, setMineruLoaded] = useState(false);
  const [mineruApiKey, setMineruApiKey] = useState('');
  const [mineruModelVersion, setMineruModelVersion] = useState('vlm');
  const [mineruLanguage, setMineruLanguage] = useState('ch');
  const [mineruEnableFormula, setMineruEnableFormula] = useState(true);
  const [mineruEnableTable, setMineruEnableTable] = useState(true);
  const [mineruIsOcr, setMineruIsOcr] = useState(false);
  const [mineruSaving, setMineruSaving] = useState(false);
  const [mineruSaved, setMineruSaved] = useState(false);
  const [profileContent, setProfileContent] = useState('');
  const [profileEnabled, setProfileEnabled] = useState(true);
  const [profileUpdateModelId, setProfileUpdateModelIdState] = useState('');
  const [profileUpdatedAt, setProfileUpdatedAt] = useState<string | null>(null);
  const [profileHistory, setProfileHistory] = useState<UserProfileVersion[]>([]);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);

  const loadSearchConfig = async () => {
    try {
      const [providers, settings] = await Promise.all([
        api.getSearchProviders(),
        api.getSettings(),
      ]);
      setSearchProviders(providers as SearchProvider[]);
      setSearchProvider((settings as any).web_search_provider || 'tavily');
      setSearchApiKey((settings as any).web_search_api_key || '');
      setSearchBaseUrl((settings as any).web_search_base_url || '');
      setSearchLoaded(true);
    } catch { /* ignore */ }
  };

  const loadMineruConfig = async () => {
    try {
      const settings = await api.getSettings();
      setMineruApiKey((settings as any).mineru_api_key || '');
      setMineruModelVersion((settings as any).mineru_model_version || 'vlm');
      setMineruLanguage((settings as any).mineru_language || 'ch');
      setMineruEnableFormula((settings as any).mineru_enable_formula !== 'false');
      setMineruEnableTable((settings as any).mineru_enable_table !== 'false');
      setMineruIsOcr((settings as any).mineru_is_ocr === 'true');
      setMineruLoaded(true);
    } catch { /* ignore */ }
  };

  const saveSearchConfig = async () => {
    setSearchSaving(true);
    setSearchSaved(false);
    try {
      await api.saveSettings({
        web_search_provider: searchProvider,
        web_search_api_key: searchApiKey,
        web_search_base_url: searchBaseUrl,
      });
      setSearchSaved(true);
      setTimeout(() => setSearchSaved(false), 2000);
    } catch { /* ignore */ }
    setSearchSaving(false);
  };

  const saveMineruConfig = async () => {
    setMineruSaving(true);
    setMineruSaved(false);
    try {
      await api.saveSettings({
        mineru_api_key: mineruApiKey,
        mineru_model_version: mineruModelVersion,
        mineru_language: mineruLanguage,
        mineru_enable_formula: String(mineruEnableFormula),
        mineru_enable_table: String(mineruEnableTable),
        mineru_is_ocr: String(mineruIsOcr),
      });
      await refreshServiceSettings();
      setMineruSaved(true);
      setTimeout(() => setMineruSaved(false), 2000);
    } catch { /* ignore */ }
    setMineruSaving(false);
  };

  const loadProfile = async () => {
    try {
      const [profile, history] = await Promise.all([
        api.getProfile(),
        api.getProfileHistory(),
      ]);
      setProfileContent(profile.content || '');
      setProfileEnabled(profile.injection_enabled !== false);
      setProfileUpdateModelIdState(profile.profile_update_model_id || '');
      setProfileUpdatedAt(profile.updated_at || null);
      setProfileHistory(history || []);
      setProfileLoaded(true);
    } catch {
      setProfileLoaded(true);
    }
  };

  const saveProfile = async () => {
    setProfileSaving(true);
    setProfileSaved(false);
    try {
      const profile = await api.saveProfile({
        content: profileContent,
        injection_enabled: profileEnabled,
        profile_update_model_id: profileUpdateModelId,
      });
      setProfileInjectionEnabledStore(profile.injection_enabled !== false);
      setProfileUpdateModelIdState(profile.profile_update_model_id || '');
      setProfileUpdatedAt(profile.updated_at || null);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
      const history = await api.getProfileHistory();
      setProfileHistory(history || []);
    } catch { /* ignore */ }
    setProfileSaving(false);
  };

  const restoreProfile = async (versionId: string) => {
    if (!confirm(t('restoreProfileConfirm'))) return;
    const profile = await api.restoreProfileVersion(versionId);
    setProfileContent(profile.content || '');
    setProfileEnabled(profile.injection_enabled !== false);
    setProfileUpdateModelIdState(profile.profile_update_model_id || '');
    setProfileInjectionEnabledStore(profile.injection_enabled !== false);
    setProfileUpdatedAt(profile.updated_at || null);
    const history = await api.getProfileHistory();
    setProfileHistory(history || []);
  };

  const setProfileUpdateModelId = (id: string) => {
    const validModelIds = new Set(visibleModels.map(m => m.id));
    const nextId = validModelIds.has(id) ? id : '';
    setProfileUpdateModelIdState(nextId);
    api.saveSettings({ profile_update_model_id: nextId }).catch(() => {});
  };

  // ━━━ 快速配置流程状态 ━━━
  // Step 1: 选供应商 → Step 2: 填 API Key + 选模型 → Step 3: 确认名称 → 保存
  // ── 快速配置状态 ──
  const [selectedProvider, setSelectedProvider] = useState<ProviderPreset | null>(null);
  const [selectedModelPreset, setSelectedModelPreset] = useState<ModelPreset | null>(null);
  const [quickApiKey, setQuickApiKey] = useState('');
  const [quickProxyUrl, setQuickProxyUrl] = useState('');
  const [quickName, setQuickName] = useState('');  // 可编辑的模型标签
  const [customMode, setCustomMode] = useState(false);

  // ━━━ 动态模型发现 ━━━
  // discoveredModels: 从供应商 API 查询到的模型列表
  // hasDiscovered: 是否已完成发现
  // ── 动态发现状态 ──
  const [discoveredModels, setDiscoveredModels] = useState<MergedModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [hasDiscovered, setHasDiscovered] = useState(false);
  // 当用户从动态列表中选择了一个不在预设中的模型
  const [selectedDiscoveredModel, setSelectedDiscoveredModel] = useState<MergedModel | null>(null);

  const [tokenUsage, setTokenUsage] = useState<TokenUsage[]>([]);
  const [tokenTotals, setTokenTotals] = useState<{ call_count: number; total_input: number; total_output: number; total_tokens: number; cumulative_usage: number } | null>(null);
  const [usageLoaded, setUsageLoaded] = useState(false);
  const [recalculating, setRecalculating] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (summaryModelId && !visibleModels.some(m => m.id === summaryModelId)) {
      setSummaryModelId('');
    }
  }, [summaryModelId, visibleModels, setSummaryModelId]);

  useEffect(() => {
    if (profileUpdateModelId && !visibleModels.some(m => m.id === profileUpdateModelId)) {
      setProfileUpdateModelId('');
    }
  }, [profileUpdateModelId, visibleModels]);

  const loadUsage = async () => {
    try {
      const data = await api.getTokenUsage();
      setTokenUsage(data.models || []);
      setTokenTotals(data.totals || null);
      setUsageLoaded(true);
    } catch {
      setTokenUsage([]);
      setTokenTotals(null);
    }
  };

  const handleRecalculate = async (modelId: string) => {
    setRecalculating(prev => new Set(prev).add(modelId));
    try {
      await api.recalculateCost(modelId);
    } catch {
      // 静默失败
    }
    setRecalculating(prev => { const next = new Set(prev); next.delete(modelId); return next; });
    await loadUsage();
  };

  // ── 动态发现模型 ──
  const discoverModels = useCallback(async (provider: ProviderPreset, apiKey: string) => {
    setDiscovering(true);
    setDiscoverError('');
    try {
      const res = await api.discoverModels(provider.provider_type, provider.base_url, apiKey);
      if (res.status === 'ok' && res.models) {
        // 与预设合并
        const presetMap = new Map<string, ModelPreset>();
        for (const mp of provider.models) {
          presetMap.set(mp.model_name, mp);
        }

        const merged: MergedModel[] = [];

        // 先添加预设中的模型（保持预设顺序）
        for (const mp of provider.models) {
          const apiMatch = res.models.find(m => m.model_name === mp.model_name);
          merged.push({
            model_name: mp.model_name,
            name: mp.name,
            source: apiMatch ? 'both' : 'preset',
            price_per_input: mp.price_per_input,
            price_per_output: mp.price_per_output,
            max_tokens: mp.max_tokens,
            thinking: mp.thinking,
            capabilities: mp.capabilities,
            owned_by: apiMatch?.owned_by,
          });
        }

        // 再添加 API 中发现但预设没有的模型
        for (const m of res.models) {
          if (!presetMap.has(m.model_name)) {
            merged.push({
              model_name: m.model_name,
              name: m.name || m.model_name,
              source: 'api',
              owned_by: m.owned_by,
            });
          }
        }

        setDiscoveredModels(merged);
        setHasDiscovered(true);
      } else {
        setDiscoverError(activeLanguage === 'en' ? 'Failed to fetch model list' : '获取模型列表失败');
      }
    } catch (e: any) {
      setDiscoverError(e.message || (activeLanguage === 'en' ? 'Network error' : '网络错误'));
    } finally {
      setDiscovering(false);
    }
  }, []);

  // ── 快速添加模型（预设模型） ──
  const handleQuickAdd = async () => {
    const model = selectedModelPreset || selectedDiscoveredModel;
    if (!selectedProvider || !model) return;
    // 二次检查：防止在 Step 2→3 过程中已被其他方式添加
    if (isModelExists(model.model_name)) {
      alert(activeLanguage === 'en' ? `Model "${model.name}" already exists and cannot be added again` : `模型 "${model.name}" 已存在，无法重复添加`);
      return;
    }
    const newModel: Partial<ModelConfig> = {
      id: '',  // 空字符串 → 后端自动生成新 ID
      name: quickName || model.name,
      provider: selectedProvider.provider_type,
      base_url: selectedProvider.base_url,
      proxy_url: quickProxyUrl.trim(),
      api_key: quickApiKey || undefined,
      model_name: model.model_name,
      max_tokens: model.max_tokens || 8192,
      price_per_input: model.price_per_input ?? 0,
      price_per_output: model.price_per_output ?? 0,
      price_unit: selectedProvider.currency,
      meta: JSON.stringify({
        capabilities: {
          image_input: modelPresetSupportsImageInput(model),
        },
      }),
    };
    await api.saveModel(newModel as any);
    await fetchModels();
    resetQuickAdd();
  };

  const resetQuickAdd = () => {
    setSelectedProvider(null);
    setSelectedModelPreset(null);
    setSelectedDiscoveredModel(null);
    setQuickApiKey('');
    setQuickProxyUrl('');
    setQuickName('');
    setShowAdd(false);
    setEditingModel(null);
    setCustomMode(false);
    setDiscoveredModels([]);
    setDiscoverError('');
    setHasDiscovered(false);
    setDiscovering(false);
  };

  // ── 传统添加模型 ──
  const handleSaveModel = async () => {
    if (!editingModel) return;
    await api.saveModel(editingModel as any);
    await fetchModels();
    setEditingModel(null);
    setShowAdd(false);
    setCustomMode(false);
  };

  // 删除模型 (调用 store.deleteModel → 乐观删除 + API + 回滚)
  const handleDeleteModel = async (modelId: string) => {
    if (confirm(activeLanguage === 'en' ? 'Delete this model configuration?' : '确定删除此模型配置？')) {
      try {
        console.log('[ConfigModal] deleteModel type:', typeof deleteModel, 'value:', deleteModel);
        if (typeof deleteModel !== 'function') {
          throw new Error(`deleteModel is not a function (got ${typeof deleteModel})`);
        }
        await deleteModel(modelId);
      } catch (e: any) {
        console.error('[ConfigModal] 删除失败:', e);
        alert((activeLanguage === 'en' ? 'Delete failed: ' : '删除失败: ') + (e?.message || (activeLanguage === 'en' ? 'Unknown error' : '未知错误')));
      }
    }
  };

  const isModelExists = (modelName: string) => visibleModels.some(m => m.model_name === modelName);

  const providerSelectValue = getProviderSelectValue(editingModel);
  const providerValueIsKnown =
    providerSelectValue === OPENAI_COMPATIBLE_PROVIDER ||
    providerSelectValue === CUSTOM_PROVIDER ||
    PROVIDER_PRESETS.some(p => p.id === providerSelectValue);

  const handleProviderChange = (providerValue: string) => {
    if (providerValue === OPENAI_COMPATIBLE_PROVIDER) {
      setEditingModel({ ...editingModel, provider: 'openai' });
      return;
    }

    if (providerValue === CUSTOM_PROVIDER) {
      setEditingModel({ ...editingModel, provider: CUSTOM_PROVIDER });
      return;
    }

    const preset = PROVIDER_PRESETS.find(p => p.id === providerValue);
    if (preset) {
      setEditingModel({
        ...editingModel,
        provider: preset.provider_type,
        base_url: preset.base_url,
        price_unit: preset.currency,
      });
      return;
    }

    setEditingModel({ ...editingModel, provider: providerValue });
  };

  // ── 当前展示的模型列表（决定用预设还是动态发现） ──
  const currentModelList = hasDiscovered ? discoveredModels :
    selectedProvider ? selectedProvider.models.map(mp => ({
      model_name: mp.model_name,
      name: mp.name,
      source: 'preset' as const,
      price_per_input: mp.price_per_input,
      price_per_output: mp.price_per_output,
      max_tokens: mp.max_tokens,
      thinking: mp.thinking,
      capabilities: mp.capabilities,
      owned_by: undefined,
    })) : [];

  // 是否正在选择一个具体模型（进入 Step 3）
  const hasSelectedModel = selectedModelPreset || selectedDiscoveredModel;

  return (
    <div className="config-overlay" onClick={onClose}>
      <div className="config-modal" onClick={e => e.stopPropagation()}>
        <div className="config-header">
          <h2 style={{ margin: 0 }}>{t('config')}</h2>
          <button onClick={onClose} className="config-close-btn"><X size={16} /></button>
        </div>

        {/* Tabs */}
        <div className="config-tabs">
          <button
            onClick={() => setActiveTab('models')}
            className={`model-chip ${activeTab === 'models' ? 'active' : ''}`}
          >
            {t('modelConfig')}
          </button>
          <button
            onClick={() => {
              setActiveTab('usage');
              loadUsage();
            }}
            className={`model-chip ${activeTab === 'usage' ? 'active' : ''}`}
          >
            {t('tokenUsage')}
          </button>
          <button
            onClick={() => {
              setActiveTab('search');
              if (!searchLoaded) loadSearchConfig();
            }}
            className={`model-chip ${activeTab === 'search' ? 'active' : ''}`}
          >
            {t('onlineSearch')}
          </button>
          <button
            onClick={() => {
              setActiveTab('mineru');
              if (!mineruLoaded) loadMineruConfig();
            }}
            className={`model-chip ${activeTab === 'mineru' ? 'active' : ''}`}
          >
            MinerU PDF
          </button>
          <button
            onClick={() => {
              setActiveTab('account');
              if (!profileLoaded) loadProfile();
            }}
            className={`model-chip ${activeTab === 'account' ? 'active' : ''}`}
          >
            {t('account')}
          </button>
        </div>

        {activeTab === 'models' && (
          <div>
            <div className="summary-model-card">
              <div className="summary-model-main">
                <div className="summary-model-copy">
                  <div className="summary-model-title">{t('autoSummary')}</div>
                  <div className={`summary-model-status ${summaryAutoEnabled ? 'enabled' : ''}`}>
                    <CheckCircle2 size={13} />
                    {summaryAutoEnabled ? (activeLanguage === 'en' ? 'Enabled' : '已启用') : (activeLanguage === 'en' ? 'Disabled' : '未启用')}
                  </div>
                </div>
                <label className="summary-auto-switch">
                  <input
                    type="checkbox"
                    checked={summaryAutoEnabled}
                    onChange={e => setSummaryAutoEnabled(e.target.checked)}
                  />
                  <span className="summary-auto-switch-track" aria-hidden="true" />
                  <span>{t('autoSummarySwitcher')}</span>
                </label>
              </div>
              <select
                className="summary-model-select"
                value={summaryModelId}
                onChange={e => setSummaryModelId(e.target.value)}
              >
                <option value="">{t('summaryModelPlaceholder')}</option>
                {visibleModels.map(model => (
                  <option key={model.id} value={model.id}>
                    {localizePresetText(model.name, activeLanguage)} / {model.model_name}
                  </option>
                ))}
              </select>
              <div className="summary-model-hint">
                {summaryAutoEnabled && !summaryModelId ? t('autoSummaryModelRequired') : t('manualSummaryModelHint')}
              </div>
              <div className="summary-model-notes">
                <span>{t('autoSummaryNote1')}</span>
                <span>{t('autoSummaryNote2')}</span>
                <span>{t('autoSummaryNote3')}</span>
              </div>
            </div>

            {/* ── 已配置的模型列表 ── */}
            {visibleModels.length > 0 && (
              <div className="model-list">
                {visibleModels.map(model => (
                  <div key={model.id} className="model-list-item">
                    <div className="model-list-info">
                      <div className="model-list-name">
                        {localizePresetText(model.name, activeLanguage)}
                        {modelSupportsImageInput(model) && (
                          <span className="vision-badge" title={activeLanguage === 'en' ? 'Supports image input' : '支持图片输入'}>
                            <ImageIcon size={12} />
                            {activeLanguage === 'en' ? 'Vision' : '视觉'}
                          </span>
                        )}
                      </div>
                      <div className="model-list-detail">
                        {getProviderDisplayName(model)} / {model.model_name}
                        {model.price_per_input > 0 && (
                          <span className="model-price">
                            {(model as any).price_unit === 'USD' ? '$' : '¥'}{(model.price_per_input * 1000).toFixed(2)}/{(model as any).price_unit === 'USD' ? '$' : '¥'}{(model.price_per_output * 1000).toFixed(2)} / 1M tokens
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setEditingModel({ ...model });
                        setCustomMode(true);
                        setShowAdd(true);
                        setSelectedProvider(null);
                        setSelectedModelPreset(null);
                      }}
                      className="btn-sm btn-outline"
                    >
                      {t('edit')}
                    </button>
                    <button onClick={() => handleDeleteModel(model.id)} className="btn-sm btn-danger-text">
                      {t('delete')}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* ── 添加模型区域 ── */}
            {showAdd ? (
              <div className="add-model-area">
                {!customMode ? (
                  /* ── 快速配置流程 ── */
                  <>
                    {/* Step 1: 选择供应商 */}
                    {!selectedProvider ? (
                      <>
                        <div className="add-step-title">{t('chooseProvider')}</div>
                        <div className="provider-grid">
                          {PROVIDER_PRESETS.map(provider => (
                            <button
                              key={provider.id}
                              className="provider-card"
                              onClick={() => setSelectedProvider(provider)}
                            >
                              <ProviderLogo logo={provider.logo} />
                              <span className="provider-name">{localizePresetText(provider.name, activeLanguage)}</span>
                            </button>
                          ))}
                          <button
                            className="provider-card provider-card-custom"
                            onClick={() => {
                              setCustomMode(true);
                              setEditingModel({ id: '', name: '', provider: 'custom', model_name: '', base_url: '', proxy_url: '', api_key: '', max_tokens: 4096, price_per_input: 0, price_per_output: 0, price_unit: 'CNY' });
                            }}
                          >
                            <span className="provider-logo" style={{ width: 24, height: 24, display: 'inline-flex', flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="6" fill="#888"/><path d="M12 8a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="white"/></svg>' }} />
                            <span className="provider-name">{t('custom')}</span>
                          </button>
                        </div>
                      </>
                    ) : !hasSelectedModel ? (
                      /* Step 2: 填 API Key + 发现模型 + 选择模型 */
                      <>
                        <div className="add-step-title">
                          <button className="back-link" onClick={() => {
                            setSelectedProvider(null);
                            setHasDiscovered(false);
                            setDiscoveredModels([]);
                            setDiscoverError('');
                          }}>{t('back')}</button>
                          {t('chooseProviderModel', { provider: localizePresetText(selectedProvider.name, activeLanguage) })}
                        </div>

                        {/* API Key 输入 + 发现按钮 */}
                        <div className="discover-section">
                          <label className="qc-api-key-label">API Key</label>
                          <div className="discover-row">
                            <input
                              type="password"
                              className="qc-api-key-input"
                              value={quickApiKey}
                              onChange={e => setQuickApiKey(e.target.value)}
                              placeholder={localizePresetText(selectedProvider.api_key_hint, activeLanguage)}
                            />
                            <button
                              className="btn btn-primary discover-btn"
                              onClick={() => discoverModels(selectedProvider, quickApiKey)}
                              disabled={discovering}
                            >
                              {discovering ? '...' : <><Search size={13} style={{verticalAlign:'-2px',marginRight:3}} /> {t('discoverModels')}</>}
                            </button>
                          </div>
                          {selectedProvider.provider_type === 'ollama' && (
                            <div style={{ fontSize: 11, color: 'var(--megaform-text-secondary)', marginTop: 4 }}>
                              {t('ollamaNoKey')}
                            </div>
                          )}
                          {discoverError && (
                            <div style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>
                              <AlertTriangle size={12} style={{verticalAlign:'-1px',marginRight:3}} /> {discoverError}
                            </div>
                          )}
                        </div>

                        {/* 模型列表：优先展示动态发现的，否则展示预设 */}
                        <div className="model-preset-list">
                          {hasDiscovered && discoveredModels.length === 0 && (
                            <div style={{ fontSize: 12, color: 'var(--megaform-text-secondary)', textAlign: 'center', padding: 16 }}>
                              {t('noModelsFound')}
                            </div>
                          )}
                          {currentModelList.map(mm => {
                            const exists = isModelExists(mm.model_name);
                            return (
                              <button
                                key={mm.model_name}
                                className={`model-preset-card ${exists ? 'already-exists' : ''} ${mm.source === 'api' ? 'model-from-api' : ''}`}
                                onClick={() => {
                                  if (exists) return;
                                  // 查找预设中的完整 ModelPreset
                                  const preset = selectedProvider.models.find(p => p.model_name === mm.model_name);
                                  if (preset) {
                                    setSelectedModelPreset(preset);
                                    setQuickName(localizePresetText(preset.name, activeLanguage));
                                  } else {
                                    setSelectedDiscoveredModel(mm);
                                    setQuickName(localizePresetText(mm.name, activeLanguage));
                                  }
                                }}
                                disabled={exists}
                              >
                                <div className="model-preset-name">
                                  {localizePresetText(mm.name, activeLanguage)}
                                  {mm.source === 'api' && <span className="api-badge">{t('apiBadge')}</span>}
                                </div>
                                <div className="model-preset-meta">
                                  <span className="model-preset-id">{mm.model_name}</span>
                                  {modelPresetSupportsImageInput(mm) && (
                                    <span className="vision-badge">
                                      <ImageIcon size={12} />
                                      {activeLanguage === 'en' ? 'Vision' : '视觉'}
                                    </span>
                                  )}
                                  {mm.thinking && <span className="thinking-badge"><Activity size={12} style={{verticalAlign:'-1px',marginRight:3}} /> {t('deepThinking')}</span>}
                                  {mm.owned_by && <span className="owned-by">{mm.owned_by}</span>}
                                </div>
                                <div className="model-preset-price">
                                  {mm.price_per_input != null && mm.price_per_input > 0
                                    ? `${getCurrencySymbol(selectedProvider.id)}${(mm.price_per_input * 1000).toFixed(2)} / ${getCurrencySymbol(selectedProvider.id)}${(mm.price_per_output! * 1000).toFixed(2)} / 1M`
                                    : mm.source === 'api' ? t('unknownPrice') : t('free')}
                                </div>
                                {exists && <div className="exists-hint">{t('added')}</div>}
                              </button>
                            );
                          })}
                        </div>

                        {!hasDiscovered && (
                          <div style={{ fontSize: 11, color: 'var(--megaform-text-secondary)', textAlign: 'center', marginTop: 8 }}>
                            {t('discoverHint')}
                          </div>
                        )}
                      </>
                    ) : (
                      /* Step 3: 确认添加 */
                      <>
                        <div className="add-step-title">
                          <button className="back-link" onClick={() => {
                            setSelectedModelPreset(null);
                            setSelectedDiscoveredModel(null);
                          }}>{t('back')}</button>
                          {t('configureModel', {
                            provider: localizePresetText(selectedProvider.name, activeLanguage),
                            model: localizePresetText((selectedModelPreset || selectedDiscoveredModel)?.name || '', activeLanguage),
                          })}
                        </div>
                        <div className="quick-config-summary">
                          <div className="qc-row">
                            <span className="qc-label">{t('provider')}</span>
                            <span className="qc-value"><ProviderLabel provider={selectedProvider} /></span>
                          </div>
                          <div className="qc-row">
                            <span className="qc-label">{t('model')}</span>
                            <span className="qc-value">
                              {localizePresetText((selectedModelPreset || selectedDiscoveredModel)?.name || '', activeLanguage)}
                              <code>{(selectedModelPreset || selectedDiscoveredModel)?.model_name}</code>
                            </span>
                          </div>
                          <div className="qc-row">
                            <span className="qc-label">{t('displayName')}</span>
                            <span className="qc-value">
                              <input
                                className="qc-name-input"
                                value={quickName}
                                onChange={e => setQuickName(e.target.value)}
                                placeholder={t('displayNamePlaceholder')}
                              />
                              <span style={{ fontSize: 10, color: 'var(--megaform-text-secondary)' }}>
                                {t('displayNameHint')}
                              </span>
                            </span>
                          </div>
                          <div className="qc-row">
                            <span className="qc-label">{t('apiUrl')}</span>
                            <span className="qc-value"><code>{selectedProvider.base_url}</code></span>
                          </div>
                          {(selectedModelPreset?.thinking || selectedDiscoveredModel?.thinking) && (
                            <div className="qc-row">
                              <span className="qc-label">{t('deepThinking')}</span>
                              <span className="qc-value thinking-available"><Activity size={12} style={{verticalAlign:'-1px',marginRight:3}} /> {t('thinkingSupported')}</span>
                            </div>
                          )}
                          {modelPresetSupportsImageInput(selectedModelPreset || selectedDiscoveredModel) && (
                            <div className="qc-row">
                              <span className="qc-label">{activeLanguage === 'en' ? 'Image input' : '图片输入'}</span>
                              <span className="qc-value vision-available">
                                <ImageIcon size={12} />
                                {activeLanguage === 'en' ? 'Supported' : '支持'}
                              </span>
                            </div>
                          )}
                          <div className="qc-row">
                            <span className="qc-label">{t('price')}</span>
                            <span className="qc-value">
                              {(() => {
                                const m = selectedModelPreset || selectedDiscoveredModel;
                                if (!m) return '-';
                                if (m.price_per_input != null && m.price_per_input > 0) {
                                  return t('priceInputOutput', {
                                    currency: getCurrencySymbol(selectedProvider.id),
                                    input: (m.price_per_input * 1000).toFixed(2),
                                    output: (m.price_per_output! * 1000).toFixed(2),
                                  });
                                }
                                if ('source' in m && m.source === 'api') return t('unknownPriceEditable');
                                return t('free');
                              })()}
                            </span>
                          </div>
                        </div>
                        <div className="qc-api-key-section">
                          <label className="qc-api-key-label">API Key</label>
                          <input
                            type="password"
                            className="qc-api-key-input"
                            value={quickApiKey}
                            onChange={e => setQuickApiKey(e.target.value)}
                            placeholder={localizePresetText(selectedProvider.api_key_hint, activeLanguage)}
                          />
                        </div>
                        <div className="qc-api-key-section">
                          <label className="qc-api-key-label">{t('proxyUrl')}</label>
                          <input
                            className="qc-api-key-input"
                            value={quickProxyUrl}
                            onChange={e => setQuickProxyUrl(e.target.value)}
                            placeholder={t('proxyUrlPlaceholder')}
                          />
                          <div className="field-hint">
                            {t('proxyUrlHint')}
                          </div>
                        </div>
                        <div className="btn-group">
                          <button onClick={resetQuickAdd} className="btn btn-outline">{t('cancel')}</button>
                          <button
                            onClick={handleQuickAdd}
                            className="btn btn-primary"
                            disabled={selectedProvider.provider_type !== 'ollama' && !quickApiKey.trim()}
                          >
                            {t('addModel').replace('+ ', '')}
                          </button>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  /* ── 自定义配置（传统表单） ── */
                  <>
                    <div className="add-step-title">
                      <button className="back-link" onClick={resetQuickAdd}>{t('backQuickConfig')}</button>
                      {t('customModelConfig')}
                    </div>
                    <div className="custom-form">
                      <label>{t('name')}</label>
                      <input
                        value={editingModel?.name || ''}
                        onChange={e => setEditingModel({ ...editingModel, name: e.target.value })}
                        placeholder="My Model"
                      />
                      <label>Provider</label>
                      <select
                        value={providerSelectValue}
                        onChange={e => handleProviderChange(e.target.value)}
                      >
                        {PROVIDER_PRESETS.map(provider => (
                          <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                        <option value={OPENAI_COMPATIBLE_PROVIDER}>{t('openaiCompatibleOther')}</option>
                        <option value={CUSTOM_PROVIDER}>{t('custom')}</option>
                        {!providerValueIsKnown && (
                          <option value={providerSelectValue}>{providerSelectValue}</option>
                        )}
                      </select>
                      <label>Model Name</label>
                      <input
                        value={editingModel?.model_name || ''}
                        onChange={e => setEditingModel({ ...editingModel, model_name: e.target.value })}
                        placeholder="model-id"
                      />
                      <label>Base URL</label>
                      <input
                        value={editingModel?.base_url || ''}
                        onChange={e => setEditingModel({ ...editingModel, base_url: e.target.value })}
                        placeholder="https://api.example.com/v1"
                      />
                      <div className="custom-form-field">
                        <label>{t('proxyUrl')}</label>
                        <input
                          value={editingModel?.proxy_url || ''}
                          onChange={e => setEditingModel({ ...editingModel, proxy_url: e.target.value })}
                          placeholder={t('proxyUrlPlaceholder')}
                        />
                        <div className="field-hint">
                          {t('proxyUrlHint')}
                        </div>
                      </div>
                      <label>API Key</label>
                      <input
                        type="password"
                        value={editingModel?.api_key || ''}
                        onChange={e => setEditingModel({ ...editingModel, api_key: e.target.value })}
                        placeholder="sk-..."
                      />
                      <label className="custom-checkbox-row">
                        <input
                          type="checkbox"
                          checked={modelSupportsImageInput(editingModel)}
                          onChange={e => setEditingModel(withImageInputCapability(editingModel || {}, e.target.checked))}
                        />
                        <span>{activeLanguage === 'en' ? 'Supports image input' : '支持图片输入'}</span>
                      </label>
                      <label>Max Tokens</label>
                      <input
                        type="number"
                        value={editingModel?.max_tokens || 4096}
                        onChange={e => setEditingModel({ ...editingModel, max_tokens: parseInt(e.target.value) || 4096 })}
                      />
                      <div className="custom-form-row">
                        <div>
                          <label>{t('inputPrice')} ({getPriceCurrencySymbol(editingModel?.price_unit)}/1m token)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={toPricePerMillionTokens(editingModel?.price_per_input)}
                            onChange={e => setEditingModel({ ...editingModel, price_per_input: fromPricePerMillionTokens(e.target.value) })}
                          />
                        </div>
                        <div>
                          <label>{t('outputPrice')} ({getPriceCurrencySymbol(editingModel?.price_unit)}/1m token)</label>
                          <input
                            type="number"
                            step="0.01"
                            value={toPricePerMillionTokens(editingModel?.price_per_output)}
                            onChange={e => setEditingModel({ ...editingModel, price_per_output: fromPricePerMillionTokens(e.target.value) })}
                          />
                        </div>
                      </div>
                      <div style={{ marginBottom: 16 }}>
                        <label>{t('currencyUnit')}</label>
                        <select
                          value={editingModel?.price_unit || 'CNY'}
                          onChange={e => setEditingModel({ ...editingModel, price_unit: e.target.value })}
                          style={{ width: '100%', marginTop: 4 }}
                        >
                          <option value="CNY">{t('cny')}</option>
                          <option value="USD">{t('usd')}</option>
                        </select>
                      </div>
                    </div>
                    <div className="btn-group">
                      <button onClick={resetQuickAdd} className="btn btn-outline">{t('cancel')}</button>
                      <button onClick={handleSaveModel} className="btn btn-primary">{t('save')}</button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                className="new-root-btn"
                onClick={() => { setShowAdd(true); }}
              >
                {t('addModel')}
              </button>
            )}
          </div>
        )}

        {activeTab === 'usage' && (
          <div>
            {!usageLoaded ? (
              <p style={{ color: 'var(--megaform-text-secondary)', textAlign: 'center' }}>{t('loading')}</p>
            ) : tokenUsage.length === 0 ? (
              <p style={{ color: 'var(--megaform-text-secondary)', textAlign: 'center' }}>{t('noData')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--megaform-border)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>{t('model')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{t('calls')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{t('inputTokens')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{t('outputTokens')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{t('totalToken')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 6px' }}>{t('cumulativeCost')}</th>
                      <th style={{ textAlign: 'center', padding: '8px 6px', width: 70 }}>{t('actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...tokenUsage]
                      .sort((a, b) => {
                        // 第一级：未删除在先，已删除在后
                        if (a.deleted !== b.deleted) return (a.deleted ?? 0) - (b.deleted ?? 0);
                        // 第二级：调用次数降序；同次数时用总 token 量兜底
                        if (a.call_count !== b.call_count) return b.call_count - a.call_count;
                        return b.total_tokens - a.total_tokens;
                      })
                      .map((u: TokenUsage) => (
                      <tr key={u.model_id} style={{ borderBottom: '1px solid var(--megaform-border)', opacity: u.deleted ? 0.4 : 1 }}>
                        <td style={{ padding: '8px 6px' }}>{u.model_name}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{u.call_count}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{u.total_input.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{u.total_output.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{u.total_tokens.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px', fontWeight: 600 }}>{u.price_unit === 'USD' ? '$' : '¥'}{(u.cumulative_usage ?? 0).toFixed(4)}</td>
                        <td style={{ textAlign: 'center', padding: '8px 6px' }}>
                          {u.deleted !== 1 && (
                          <button
                            onClick={e => { e.stopPropagation(); handleRecalculate(u.model_id); }}
                            disabled={recalculating.has(u.model_id)}
                            title={t('recalcUsage')}
                            style={{
                              background: 'none',
                              border: '1px solid var(--megaform-border)',
                              borderRadius: 4,
                              cursor: 'pointer',
                              fontSize: 12,
                              padding: '2px 6px',
                              color: 'var(--megaform-text-secondary)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {recalculating.has(u.model_id) ? <Loader size={12} style={{verticalAlign:'-2px'}} /> : <RefreshCcw size={12} style={{verticalAlign:'-2px'}} />}
                          </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {tokenTotals && (
                      <tr style={{ borderTop: '2px solid var(--megaform-border)', fontWeight: 600 }}>
                        <td style={{ padding: '8px 6px' }}>{t('total')}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{tokenTotals.call_count}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{tokenTotals.total_input.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{tokenTotals.total_output.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px' }}>{tokenTotals.total_tokens.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', padding: '8px 6px', fontWeight: 600 }}>¥{(tokenTotals.cumulative_usage ?? 0).toFixed(4)}</td>
                        <td style={{ textAlign: 'center', padding: '8px 6px' }}></td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'search' && (
          <div>
            {!searchLoaded ? (
              <p style={{ color: 'var(--megaform-text-secondary)', textAlign: 'center', padding: 24 }}>{t('loading')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* 提供商选择 */}
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, display: 'block', color: 'var(--megaform-text-secondary)' }}>
                    {t('searchProvider')}
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                    {searchProviders.map((sp) => (
                      <div
                        key={sp.id}
                        onClick={() => {
                          setSearchProvider(sp.id);
                          setSearchBaseUrl(sp.base_url);
                        }}
                        className={`model-preset-card${searchProvider === sp.id ? ' selected' : ''}`}
                        style={{ cursor: 'pointer', padding: 10, fontSize: 13 }}
                        title={localizeSearchProviderText(sp.api_key_hint, activeLanguage)}
                      >
                        <div style={{ fontWeight: 500 }}>{localizeSearchProviderText(sp.name, activeLanguage)}</div>
                        <div style={{ fontSize: 11, color: 'var(--megaform-text-secondary)', marginTop: 2 }}>{localizeSearchProviderText(sp.free_tier, activeLanguage)}</div>
                        <div style={{ fontSize: 11, color: 'var(--megaform-text-secondary)' }}>{localizeSearchProviderText(sp.pricing, activeLanguage)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* API Key */}
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block', color: 'var(--megaform-text-secondary)' }}>
                    API Key
                  </label>
                  <input
                    type="password"
                    value={searchApiKey}
                    onChange={e => setSearchApiKey(e.target.value)}
                    placeholder={
                      localizeSearchProviderText(searchProviders.find(sp => sp.id === searchProvider)?.api_key_hint || t('apiKeyPlaceholder'), activeLanguage)
                    }
                    className="config-input"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
                  />
                </div>

                {/* Base URL (可编辑) */}
                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block', color: 'var(--megaform-text-secondary)' }}>
                    {t('apiUrl')}
                  </label>
                  <input
                    type="text"
                    value={searchBaseUrl}
                    onChange={e => setSearchBaseUrl(e.target.value)}
                    placeholder="https://..."
                    className="config-input"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
                  />
                </div>

                {/* Save */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={saveSearchConfig}
                    disabled={searchSaving || !searchProvider}
                    className="model-chip active"
                    style={{ fontWeight: 500 }}
                  >
                    {searchSaving ? t('saving') : t('saveSearchConfig')}
                  </button>
                  {searchSaved && (
                    <span style={{ color: 'var(--megaform-stone-600)', fontSize: 13 }}><CheckCircle2 size={13} style={{verticalAlign:'-2px',marginRight:3}} /> {t('saved')}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'mineru' && (
          <div>
            {!mineruLoaded ? (
              <p style={{ color: 'var(--megaform-text-secondary)', textAlign: 'center', padding: 24 }}>{t('loading')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--megaform-text)', marginBottom: 4 }}>
                    MinerU PDF
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--megaform-text-secondary)' }}>
                    {activeLanguage === 'en'
                      ? 'Used by the PDF upload button to convert papers into Markdown responses.'
                      : '用于输入栏 PDF 上传入口，把论文转成 Markdown response。'}
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block', color: 'var(--megaform-text-secondary)' }}>
                    MinerU API Key
                  </label>
                  <input
                    type="password"
                    value={mineruApiKey}
                    onChange={e => setMineruApiKey(e.target.value)}
                    placeholder={activeLanguage === 'en' ? 'MinerU API token' : 'MinerU 官网申请的 API Token'}
                    className="config-input"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                  <label style={{ fontSize: 13, color: 'var(--megaform-text-secondary)' }}>
                    <span style={{ display: 'block', marginBottom: 4 }}>{activeLanguage === 'en' ? 'Model' : '模型'}</span>
                    <select className="config-input" value={mineruModelVersion} onChange={e => setMineruModelVersion(e.target.value)}>
                      <option value="vlm">vlm</option>
                      <option value="pipeline">pipeline</option>
                    </select>
                  </label>
                  <label style={{ fontSize: 13, color: 'var(--megaform-text-secondary)' }}>
                    <span style={{ display: 'block', marginBottom: 4 }}>{activeLanguage === 'en' ? 'Language' : '语言'}</span>
                    <input
                      className="config-input"
                      value={mineruLanguage}
                      onChange={e => setMineruLanguage(e.target.value)}
                      placeholder="ch / en"
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 13, color: 'var(--megaform-text-secondary)' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={mineruEnableFormula} onChange={e => setMineruEnableFormula(e.target.checked)} />
                    {activeLanguage === 'en' ? 'Formula recognition' : '公式识别'}
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={mineruEnableTable} onChange={e => setMineruEnableTable(e.target.checked)} />
                    {activeLanguage === 'en' ? 'Table recognition' : '表格识别'}
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={mineruIsOcr} onChange={e => setMineruIsOcr(e.target.checked)} />
                    OCR
                  </label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    onClick={saveMineruConfig}
                    disabled={mineruSaving}
                    className="model-chip active"
                    style={{ fontWeight: 500 }}
                  >
                    {mineruSaving ? t('saving') : (activeLanguage === 'en' ? 'Save MinerU config' : '保存 MinerU 配置')}
                  </button>
                  {mineruSaved && (
                    <span style={{ color: 'var(--megaform-stone-600)', fontSize: 13 }}><CheckCircle2 size={13} style={{verticalAlign:'-2px',marginRight:3}} /> {t('saved')}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'account' && (
          <div className="account-settings">
            <div className="account-settings-card">
              <div className="account-settings-avatar">
                {currentUser?.avatar_url ? (
                  <img src={currentUser.avatar_url} alt="" />
                ) : (
                  <User size={22} />
                )}
              </div>
              <div className="account-settings-main">
                <div className="account-settings-name">{currentUser?.display_name || t('notLoggedIn')}</div>
                <div className="account-settings-meta">
                  {localMode ? t('localMode') : currentUser?.email || t('oauthLogin')}
                </div>
              </div>
            </div>

            <div className="account-settings-section">
              <div className="account-settings-title">{t('language')}</div>
              <select
                className="config-input"
                value={language}
                onChange={e => onLanguageChange(e.target.value as Language)}
              >
                {LANGUAGES.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="account-settings-section">
              <div className="account-settings-title">{t('loginStatus')}</div>
              <div className="account-settings-copy">
                {localMode
                  ? t('localModeCopy')
                  : t('oauthModeCopy')}
              </div>
              <div className="account-settings-actions">
                {!localMode && (
                  <button className="btn btn-outline" onClick={() => { window.location.href = api.googleLoginUrl(window.location.pathname, language); }}>
                    <User size={14} />
                    {t('bindSwitchGoogle')}
                  </button>
                )}
                <button className="btn btn-outline" onClick={() => onLogout(false)}>
                  <LogOut size={14} />
                  {localMode ? t('clearLocalSession') : t('logoutDevice')}
                </button>
                {!localMode && (
                  <button className="btn btn-danger" onClick={() => onLogout(true)}>
                    <LogOut size={14} />
                    {t('logoutAllDevices')}
                  </button>
                )}
              </div>
            </div>

            <div className="account-settings-section">
              <div className="account-settings-title">Profile</div>
              {!profileLoaded ? (
                <p style={{ color: 'var(--megaform-text-secondary)', textAlign: 'center', padding: 24 }}>{t('loading')}</p>
              ) : (
                <div className="profile-settings">
                  <div className="profile-toolbar">
                    <label className="profile-toggle">
                      <input
                        type="checkbox"
                        checked={profileEnabled}
                        onChange={e => setProfileEnabled(e.target.checked)}
                      />
                      {t('profileDefaultInject')}
                    </label>
                    <span className="profile-updated">
                      {profileUpdatedAt ? t('updatedAt', { time: profileUpdatedAt }) : t('notSaved')}
                    </span>
                  </div>
                  <div className="profile-auto-update">
                    <div className="profile-auto-update-label">
                      <Bot size={14} />
                      <span>{t('profileAutoUpdateModel')}</span>
                    </div>
                    <select
                      className="summary-model-select"
                      value={profileUpdateModelId}
                      onChange={e => setProfileUpdateModelId(e.target.value)}
                    >
                      <option value="">{t('profileAutoUpdateOff')}</option>
                      {visibleModels.map(model => (
                        <option key={model.id} value={model.id}>
                          {localizePresetText(model.name, activeLanguage)} / {model.model_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="profile-auto-update-note">
                    {t('profileAutoUpdateNote')}
                  </div>
                  <textarea
                    className="profile-editor"
                    value={profileContent}
                    onChange={e => setProfileContent(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="profile-actions">
                    <button
                      className="btn btn-primary"
                      onClick={saveProfile}
                      disabled={profileSaving}
                    >
                      <FileText size={14} />
                      {profileSaving ? t('saving') : t('saveProfile')}
                    </button>
                    {profileSaved && (
                      <span className="profile-saved"><CheckCircle2 size={13} /> {t('saved')}</span>
                    )}
                  </div>
                  <div className="profile-history">
                    <div className="profile-history-title"><History size={14} /> {t('profileHistory')}</div>
                    {profileHistory.length === 0 ? (
                      <div className="profile-history-empty">{t('noProfileHistory')}</div>
                    ) : (
                      profileHistory.map(version => (
                        <div key={version.id} className="profile-history-row">
                          <div className="profile-history-main">
                            <div className="profile-history-time">{version.created_at}</div>
                            <div className="profile-history-note">{version.note || t('manualSave')} · {version.content.length.toLocaleString()} {t('chars')}</div>
                          </div>
                          <button className="btn-sm btn-outline" onClick={() => restoreProfile(version.id)}>
                            {t('restore')}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
