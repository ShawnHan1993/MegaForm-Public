/**
 * InputBar — 底部输入栏
 * 
 * 职责：
 * - 统一问题输入（新问题树 / 基于聚焦节点的递进探索）
 * - 模型选择 pills（多选，支持 toggle）
 * - 深度思考模式配置（右键/双击模型 pill 弹出思考深度选择）
 * - 联网搜索开关
 * - 发送消息（区分新问题树 / 递进关系两种场景）
 * - 错误信息展示与清除
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import { getThinkingDepthClass, getThinkingLevels, type ThinkingLevel } from '../data/thinkingPresets';
import type { Node as RootNode } from '../types';
import { SearchOutlined } from '@ant-design/icons';
import { Activity, X, AlertTriangle, ArrowUp, UserRound } from 'lucide-react';
import { localizeThinkingDescription, localizeThinkingLabel, useLanguage, useT } from '../i18n';

const INPUT_MAX_HEIGHT = 200;  // textarea 最高上限 px
type ThinkingPopoverPosition = { left: number; bottom: number } | null;

export default function InputBar() {
  const language = useLanguage();
  const t = useT();
  const models = useAppStore(s => s.models);
  // 过滤已删除的模型（deleted 为1表示标记为删除）
  const visibleModels = useMemo(() => {
    return models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => model.deleted !== 1)
      .sort((a, b) => {
        const usageDiff = (b.model.recent_usage_count || 0) - (a.model.recent_usage_count || 0);
        if (usageDiff !== 0) return usageDiff;
        const tokenDiff = (b.model.recent_token_usage || 0) - (a.model.recent_token_usage || 0);
        if (tokenDiff !== 0) return tokenDiff;
        return a.index - b.index;
      })
      .map(({ model }) => model);
  }, [models]);
  const selectedModelIds = useAppStore(s => s.selectedModelIds);
  const focusedNodeId = useAppStore(s => s.focusedNodeId);
  const currentRootId = useAppStore(s => s.currentRootId);
  const rootTree = useAppStore(s => s.rootTree);
  const sendMessage = useAppStore(s => s.sendMessage);
  const sendingMessage = useAppStore(s => s.sendingMessage);
  const setSelectedModelIds = useAppStore(s => s.setSelectedModelIds);
  const thinkingBudgets = useAppStore(s => s.thinkingBudgets);
  const setThinkingBudget = useAppStore(s => s.setThinkingBudget);
  const error = useAppStore(s => s.error);
  const clearError = useAppStore(s => s.clearError);
  const webSearchEnabled = useAppStore(s => s.webSearchEnabled);
  const setWebSearchEnabled = useAppStore(s => s.setWebSearchEnabled);
  const profileInjectionEnabled = useAppStore(s => s.profileInjectionEnabled);
  const setProfileInjectionEnabled = useAppStore(s => s.setProfileInjectionEnabled);

  const [input, setInput] = useState('');
  const [thinkingPopoverFor, setThinkingPopoverFor] = useState<string | null>(null);
  const [thinkingPopoverPosition, setThinkingPopoverPosition] = useState<ThinkingPopoverPosition>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 侧边栏"新问题树"触发时自动聚焦输入框
  const inputFocusTrigger = useAppStore(s => s.inputFocusTrigger);
  useEffect(() => {
    if (inputFocusTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [inputFocusTrigger]);

  // 输入内容变化时自动调整 textarea 高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, INPUT_MAX_HEIGHT) + 'px';
  }, [input]);

  // 点击外部关闭 thinking popover
  useEffect(() => {
    if (!thinkingPopoverFor) return;
    const closeThinkingPopover = () => {
      setThinkingPopoverFor(null);
      setThinkingPopoverPosition(null);
    };
    const handlePointerDown = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closeThinkingPopover();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', closeThinkingPopover);
    window.addEventListener('orientationchange', closeThinkingPopover);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', closeThinkingPopover);
      window.removeEventListener('orientationchange', closeThinkingPopover);
    };
  }, [thinkingPopoverFor]);

  const getMobilePopoverPosition = (target: HTMLElement): ThinkingPopoverPosition => {
    if (window.innerWidth > 768) return null;
    const rect = target.getBoundingClientRect();
    const popoverHalfWidth = 100;
    const edgePadding = 14;
    const left = Math.min(
      window.innerWidth - edgePadding - popoverHalfWidth,
      Math.max(edgePadding + popoverHalfWidth, rect.left + rect.width / 2),
    );
    return {
      left,
      bottom: Math.max(82, window.innerHeight - rect.top + 8),
    };
  };

  const toggleThinkingPopover = (modelId: string, target: HTMLElement) => {
    const isClosing = thinkingPopoverFor === modelId;
    setThinkingPopoverFor(isClosing ? null : modelId);
    setThinkingPopoverPosition(isClosing ? null : getMobilePopoverPosition(target));
  };

  /** 在问题树中 DFS 查找节点（用于获取聚焦节点信息） */
  const getNodeById = (nodes: RootNode[], id: string): RootNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children?.length) {
        const found = getNodeById(n.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  const focusedNode = focusedNodeId && rootTree
    ? getNodeById(rootTree, focusedNodeId)
    : null;

  // V3: 统一发送 — 始终作为聚焦节点的 progression 子节点
  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput(''); // 立即清空，不等 API 返回

    if (!currentRootId) {
      // 新问题树
      await sendMessage(text, { webSearch: webSearchEnabled });
    } else if (focusedNode) {
      // 作为聚焦节点的 progression 子节点
      await sendMessage(text, {
        rootId: currentRootId,
        parentId: focusedNode.id,
        relation: 'progression',
        webSearch: webSearchEnabled,
      });
    } else {
      // 有问题树但无聚焦节点（不应发生，安全回退）
      await sendMessage(text, {
        rootId: currentRootId,
        webSearch: webSearchEnabled,
      });
    }
  };

  const toggleModel = (modelId: string) => {
    if (selectedModelIds.includes(modelId)) {
      setSelectedModelIds(selectedModelIds.filter(id => id !== modelId));
    } else {
      setSelectedModelIds([...selectedModelIds, modelId]);
    }
  };

  const getModelThinkingLevels = (model: { provider: string; model_name: string }): ThinkingLevel[] | undefined => {
    return getThinkingLevels(model.provider, model.model_name);
  };

  // 输入框提示文字
  const getPlaceholder = () => {
    if (!currentRootId) return t('inputQuestion');
    if (focusedNode) {
      const snippet = focusedNode.content.slice(0, 20);
      return t('exploreBasedOn', { text: snippet });
    }
    return t('inputNewQuestion');
  };

  return (
    <div className={`input-bar${currentRootId ? ' root-mode' : ''}`}>
      <div className="input-wrapper">
        <div className="input-textarea-clip">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                // 跳过输入法（IME）组合态中的 Enter —— 用户还在选字
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={getPlaceholder()}
            disabled={sendingMessage}
            rows={1}
          />
        </div>

        <div className="input-toolbar">
          {/* 模型选择 */}
          <div
            className={`model-pills${thinkingPopoverFor ? ' has-thinking-popover' : ''}`}
            onScroll={() => {
              if (thinkingPopoverPosition) {
                setThinkingPopoverFor(null);
                setThinkingPopoverPosition(null);
              }
            }}
          >
            {visibleModels.map(model => {
              const isSelected = selectedModelIds.includes(model.id);
              const thinkingLevels = getModelThinkingLevels(model);
              const currentBudget = thinkingBudgets[model.id] || 0;
              const hasThinking = thinkingLevels && thinkingLevels.length > 0;

              return (
                <div key={model.id} className="model-pill-wrap">
                  <button
                    className={`model-pill ${isSelected ? 'selected' : ''}`}
                    onClick={() => toggleModel(model.id)}
                    onContextMenu={(e) => {
                      // 右键点击支持思考模式的模型 → 弹出思考深度选择
                      if (hasThinking && isSelected) {
                        e.preventDefault();
                        toggleThinkingPopover(model.id, e.currentTarget);
                      }
                    }}
                    onDoubleClick={(e) => {
                      // 双击也弹出思考深度选择
                      if (hasThinking && isSelected) {
                        e.preventDefault();
                        toggleThinkingPopover(model.id, e.currentTarget);
                      }
                    }}
                  >
                    {model.name}
                    {hasThinking && isSelected && currentBudget > 0 && (
                      <span
                        className={`thinking-indicator ${getThinkingDepthClass(thinkingLevels, currentBudget)}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleThinkingPopover(model.id, e.currentTarget);
                        }}
                        title={t('adjustThinkingDepth', { label: localizeThinkingLabel(thinkingLevels?.find(l => l.budget === currentBudget)?.label || String(currentBudget), language) })}
                      >
                        <Activity size={13} />
                      </span>
                    )}
                    {hasThinking && isSelected && currentBudget === 0 && (
                      <span
                        className="thinking-toggle-hint"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleThinkingPopover(model.id, e.currentTarget);
                        }}
                        title={t('chooseThinkingDepth')}
                        style={{ marginLeft: 2, cursor: 'pointer', opacity: 0.5, fontSize: 11, display: 'inline-flex', alignItems: 'center' }}
                      >
                        <Activity size={13} />
                      </span>
                    )}
                  </button>

                  {/* 深度思考 Popover */}
                  {thinkingPopoverFor === model.id && hasThinking && (
                    <div
                      className={`thinking-popover${thinkingPopoverPosition ? ' mobile-fixed' : ''}`}
                      ref={popoverRef}
                      style={thinkingPopoverPosition ? {
                        left: thinkingPopoverPosition.left,
                        bottom: thinkingPopoverPosition.bottom,
                      } : undefined}
                    >
                      <div className="thinking-popover-title" style={{ display: 'flex', alignItems: 'center' }}><Activity size={14} style={{ marginRight: 4 }} /> {t('thinkingDepth')}</div>
                      {thinkingLevels!.map(level => (
                        <button
                          key={level.budget}
                          className={`thinking-level-btn ${currentBudget === level.budget ? 'active' : ''}`}
                          onClick={() => {
                            setThinkingBudget(model.id, level.budget);
                            setThinkingPopoverFor(null);
                            setThinkingPopoverPosition(null);
                          }}
                        >
                          <span className="thinking-level-label">{localizeThinkingLabel(level.label, language)}</span>
                          <span className="thinking-level-desc">{localizeThinkingDescription(level.description, language)}</span>
                        </button>
                      ))}
                      <button
                        className={`thinking-off-btn ${currentBudget === 0 ? 'active' : ''}`}
                        onClick={() => {
                          setThinkingBudget(model.id, 0);
                          setThinkingPopoverFor(null);
                          setThinkingPopoverPosition(null);
                        }}
                      >
                        <X size={12} style={{ marginRight: 3 }} /> {t('disableThinking')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <button
              className={`model-pill search-pill ${webSearchEnabled ? 'selected' : ''}`}
              onClick={() => setWebSearchEnabled(!webSearchEnabled)}
              title={t('webSearch')}
            >
              <SearchOutlined />
            </button>
            <button
              className={`model-pill search-pill ${profileInjectionEnabled ? 'selected' : ''}`}
              onClick={() => setProfileInjectionEnabled(!profileInjectionEnabled)}
              title={profileInjectionEnabled ? t('profileInjectOn') : t('profileInjectOff')}
            >
              <UserRound size={14} />
            </button>
          </div>

          <div className="input-toolbar-right">
            <button
              onClick={handleSend}
              disabled={sendingMessage || !input.trim()}
              className="send-btn"
              title={t('send')}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>

        {error && (
          <div className="input-error">
            <span className="input-error-text"><AlertTriangle size={12} /> {error}</span>
            <button onClick={clearError} className="input-error-close">
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
