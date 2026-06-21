import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/appStore';
import { api } from '../api/client';
import type { Node } from '../types';
import ResponseArea from './ResponseArea';
import MarkdownContent from './MarkdownContent';
import ReferencePreview from './ReferencePreview';
import { BookOpenText, ChevronDown, ChevronsUpDown, Crosshair, Ellipsis, MoveRight, Pencil, RefreshCcw, Trash, CircleAlert, FileText, Sparkles } from 'lucide-react';
import { useT } from '../i18n';
import { getNutReferenceText } from '../utils/referenceText';

/** NodeCard 组件 Props */
interface Props {
  node: Node;                        // 当前节点数据
  depth: number;                     // 当前深度（用于缩进等样式）
  suppressEnterAnimation?: boolean;  // 相机下钻提交帧：避免新卡片再次入场弹动
}

/**
 * NodeCard — 对话树节点卡片组件
 *
 * 核心职责：
 * 1. 渲染问题区（折叠箭头 + 问题文本 + 编辑 + 重跑）
 * 2. 折叠状态：每个节点只有 collapsed 一个布尔状态，折叠只影响自身，不影响子节点。
 * 3. 仅点击折叠箭头折叠/展开，双击问题区聚焦该节点
 * 4. ⋯ 菜单：聚焦 / 切换折叠 / 沉浸式浏览 / 编辑并重跑 / 重跑不修改 / 删除节点
 * 5. 编辑模式（textarea 编辑问题内容）
 * 6. 渲染 ResponseArea 回答区 + progression 子节点
 * 7. 沉浸式浏览（隐藏追问分支）
 */
export default function NodeCard({ node, depth, suppressEnterAnimation = false }: Props) {
  const t = useT();
  // ────── 全局状态 ──────
  const collapsedSet = useAppStore(s => s.collapsedSet);           // 折叠节点 ID 集合
  const immersiveHiddenSet = useAppStore(s => s.immersiveHiddenSet); // 沉浸式隐藏节点 ID 集合
  const toggleCollapse = useAppStore(s => s.toggleCollapse);       // 折叠/展开切换
  const setDescendantsCollapse = useAppStore(s => s.setDescendantsCollapse); // 递归折叠/展开
  const toggleImmersive = useAppStore(s => s.toggleImmersive);     // 沉浸式浏览切换
  const focusNode = useAppStore(s => s.focusNode);                 // 全局聚焦节点
  const getNodeById = useAppStore(s => s.getNodeById);             // 根据 ID 查找节点
  const models = useAppStore(s => s.models);                       // 模型列表
  const deleteNode = useAppStore(s => s.deleteNode);               // 删除节点
  const rerunNode = useAppStore(s => s.rerunNode);                 // 重跑节点
  const summaryModelId = useAppStore(s => s.summaryModelId);       // 自动摘要模型
  const generateNodeSummary = useAppStore(s => s.generateNodeSummary); // 手动触发自动摘要
  const sendingMessage = useAppStore(s => s.sendingMessage);       // 是否正在发送消息
  const streamingNodeIds = useAppStore(s => s.streamingNodeIds);     // 所有流式输出的节点 ID 集合
  const streamingResponses = useAppStore(s => s.streamingResponses); // 流式响应数据 (复合键 nodeId:modelId)
  const searchScrollTarget = useAppStore(s => s.searchScrollTarget); // 搜索结果命中定位

  // ────── 折叠状态 ──────
  // selfCollapsed：此节点在 collapsedSet 中，用户主动折叠
  const selfCollapsed = collapsedSet.has(node.id);
  // hideResponses：是否隐藏回复区域
  const hideResponses = selfCollapsed;
  const isImmersive = immersiveHiddenSet.has(node.id);            // 沉浸式浏览态
  const meta = JSON.parse(node.meta || '{}');                     // 节点元数据
  const hasChildren = node.children && node.children.length > 0;   // 是否有子节点
  const hasResponses = node.responses && node.responses.length > 0; // 是否有回复
  const isLogicalNode = meta.kind === 'logic';
  // canCollapse：逻辑节点即使没有模型回复，也可进入与普通节点一致的紧凑折叠态
  const canCollapse = isLogicalNode || hasChildren || hasResponses;
  const hasFollowupChildren = (node.children || []).some(c => c.relation === 'followup');

  // ────── 流式状态 ──────
  // isStreaming：当前节点是否为流式输出目标
  const isStreaming = streamingNodeIds.has(node.id);
  // 过滤出本节点的流式响应（streamingResponses 的 key 格式为 nodeId:modelId）
  const nodePrefix = node.id + ':';
  const nodeStreamingResponses: Record<string, import('../types').StreamingResponse> = {};
  if (isStreaming) {
    for (const [key, val] of Object.entries(streamingResponses)) {
      if (key.startsWith(nodePrefix)) {
        const modelId = key.slice(nodePrefix.length);
        nodeStreamingResponses[modelId] = val;
      }
    }
  }
  const hasStreamingResponses = Object.keys(nodeStreamingResponses).length > 0;

  // ────── 操作菜单状态 ──────
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null); // 菜单容器 ref，用于外部点击检测
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuPopupRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });

  // ────── 编辑模式状态 ──────
  const [editing, setEditing] = useState(false);       // 是否处于编辑模式
  const [editContent, setEditContent] = useState('');   // 编辑中的文本内容
  const editRef = useRef<HTMLTextAreaElement>(null);    // textarea ref，用于自动聚焦

  // ────── 删除确认状态（两步确认防止误删） ──────
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ────── 摘要编辑状态 ──────
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryText, setSummaryText] = useState('');
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const summaryRef = useRef<HTMLTextAreaElement>(null);

  // 开始编辑摘要
  const startSummaryEdit = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSummaryText(node.summary || '');
    setSummaryEditing(true);
    setMenuOpen(false);
  }, [node.summary]);

  // 保存摘要
  const saveSummary = useCallback(async () => {
    const text = summaryText.trim();
    try {
      await api.updateSummary(node.id, text);
      // 就地更新 rootTree 中的 node.summary，面包屑 & 折叠态即刻反映
      useAppStore.setState((prev: any) => {
        const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
        const nodeCache = { ...prev.nodeCache };
        const patchNode = (nodes: any[]): boolean => {
          for (const n of nodes) {
            if (n.id === node.id) {
              n.summary = text;
              return true;
            }
            if (n.children?.length && patchNode(n.children)) return true;
          }
          return false;
        };
        patchNode(tree);
        if (nodeCache[node.id]) nodeCache[node.id] = { ...nodeCache[node.id], summary: text };
        const recentNodes = (prev.recentNodes || []).map((recentNode: any) =>
          recentNode.id === node.id ? { ...recentNode, summary: text } : recentNode
        );
        return { rootTree: tree, nodeCache, recentNodes };
      });
    } catch (e) {
      console.error('保存摘要失败:', e);
    }
    setSummaryEditing(false);
  }, [node.id, summaryText]);

  const handleAutoSummary = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!summaryModelId || summaryGenerating) return;
    setSummaryGenerating(true);
    setMenuOpen(false);
    try {
      await generateNodeSummary(node.id, { force: true });
    } catch (err) {
      console.error('自动摘要失败:', err);
    } finally {
      setSummaryGenerating(false);
    }
  }, [generateNodeSummary, node.id, summaryGenerating, summaryModelId]);

  // 摘要 textarea 键盘处理
  const handleSummaryKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      saveSummary();
    } else if (e.key === 'Escape') {
      setSummaryEditing(false);
    }
  }, [saveSummary]);

  // 摘要编辑自动聚焦
  useEffect(() => {
    if (summaryEditing) {
      setTimeout(() => summaryRef.current?.focus(), 50);
    }
  }, [summaryEditing]);

  // ────── 子节点分类 ──────
  // 区分 followup（追问）和 progression（推演）子节点
  // 沉浸式浏览时隐藏所有 followup 子节点，只显示回答内容
  const followupChildren = isImmersive
    ? []
    : (node.children || []).filter(c => c.relation === 'followup');
  // 折叠时追问子节点不从 ResponseArea 内联渲染，而是独立排列在卡片下方
  const responseFollowupChildren = selfCollapsed ? [] : followupChildren;
  const progressionChildren = (node.children || []).filter(
    c => c.relation !== 'followup'
  );

  // ────── 入场动画（首次渲染 500ms 后移除 entering class） ──────
  const [entering, setEntering] = useState(!suppressEnterAnimation);
  useEffect(() => {
    if (suppressEnterAnimation) {
      setEntering(false);
      return;
    }
    const timer = setTimeout(() => setEntering(false), 500);
    return () => clearTimeout(timer);
  }, [suppressEnterAnimation]);

  // 所有回复数据
  const responses = node.responses || [];
  const questionSearchHit = searchScrollTarget?.type === 'node' && searchScrollTarget.nodeId === node.id
    ? {
        query: searchScrollTarget.query.trim(),
        hitId: `search-${searchScrollTarget.requestId}`,
      }
    : null;
  const activeModelIds = useMemo(
    () => new Set(models.filter(m => m.deleted !== 1).map(m => m.id)),
    [models],
  );
  const rerunModelIds = useMemo(
    () => [...new Set(responses.map(r => r.model_id).filter(Boolean))].filter(id => activeModelIds.has(id)),
    [responses, activeModelIds],
  );

  const getFollowupPosition = useCallback((child: Node) => {
    if (!child.nut_id) return { responseIndex: Number.MAX_SAFE_INTEGER, seek: Number.MAX_SAFE_INTEGER, endSeek: Number.MAX_SAFE_INTEGER };

    for (let responseIndex = 0; responseIndex < responses.length; responseIndex++) {
      const nut = responses[responseIndex].nuts?.find(n => n.id === child.nut_id);
      if (nut) {
        return {
          responseIndex,
          seek: nut.seek,
          endSeek: nut.end_seek,
        };
      }
    }

    return { responseIndex: Number.MAX_SAFE_INTEGER, seek: Number.MAX_SAFE_INTEGER, endSeek: Number.MAX_SAFE_INTEGER };
  }, [responses]);

  const sortedFollowupChildren = useMemo(() => {
    return [...followupChildren].sort((a, b) => {
      const pa = getFollowupPosition(a);
      const pb = getFollowupPosition(b);
      return (
        pa.responseIndex - pb.responseIndex ||
        pa.seek - pb.seek ||
        pa.endSeek - pb.endSeek ||
        a.child_order - b.child_order
      );
    });
  }, [followupChildren, getFollowupPosition]);

  const sortedProgressionChildren = useMemo(() => {
    return [...progressionChildren].sort((a, b) => a.child_order - b.child_order);
  }, [progressionChildren]);

  const collapsedChildren = useMemo(() => {
    return [...sortedFollowupChildren, ...sortedProgressionChildren];
  }, [sortedFollowupChildren, sortedProgressionChildren]);

  const truncateText = useCallback((text: string, maxLen: number): string => {
    const chars = Array.from(text.trim());
    return chars.length > maxLen ? chars.slice(0, maxLen).join('') : chars.join('');
  }, []);

  const truncateTextWithEllipsis = useCallback((text: string, maxLen: number): string => {
    const chars = Array.from(text.trim());
    return chars.length > maxLen ? `${chars.slice(0, maxLen).join('')}...` : chars.join('');
  }, []);

  const followupQuote = useMemo(() => {
    if (node.relation !== 'followup' || !node.nut_id || !node.parent_id) return null;
    const parent = getNodeById(node.parent_id);
    if (!parent?.responses) return null;
    for (const response of parent.responses) {
      const nut = response.nuts?.find(n => n.id === node.nut_id);
      if (nut) return getNutReferenceText(response.content, nut, nut.label || '');
    }
    return null;
  }, [getNodeById, node.nut_id, node.parent_id, node.relation]);

  /**
   * handleToggle — 折叠/展开切换，仅由 collapse-toggle 按钮触发。
   *
   * 单击：仅 toggle 自身折叠状态。
   * 双击：toggle 自身后，将新状态传播给所有子节点。
   */
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickCountRef = useRef(0);

  const handleToggle = useCallback(() => {
    if (!canCollapse) return;

    clickCountRef.current += 1;

    if (clickCountRef.current === 1) {
      // 第一个单击：设置 300ms 倒计时
      clickTimerRef.current = setTimeout(() => {
        // 超时 → 确认为单击
        toggleCollapse(node.id);
        clickCountRef.current = 0;
        clickTimerRef.current = null;
      }, 300);
    } else {
      // 第二次点击（双击）
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      toggleCollapse(node.id);
      // 用 toggle 后的新状态传播给子节点
      // toggleCollapse 先执行，会翻转 collapsedSet，然后立即读出新值
      const newCollapsed = !collapsedSet.has(node.id);
      setDescendantsCollapse(node.id, newCollapsed);
      clickCountRef.current = 0;
    }
  }, [canCollapse, node.id, toggleCollapse, setDescendantsCollapse, collapsedSet]);

  /**
   * countDescendants — 递归计算节点的后代总数（用于删除确认提示）
   */
  const countDescendants = (n: Node): number => {
    const children = n.children || [];
    return children.reduce((acc, c) => acc + 1 + countDescendants(c), 0);
  };

  // ────── 折叠态摘要信息 ──────
  // 折叠后显示的模型标签列表（最多 3 个 + 溢出计数）
  const modelChips = responses.map(r => {
    const model = models.find(m => m.id === r.model_id);
    return model?.name || r.model_id;
  });

  // 折叠后显示的 token 总量（输入 + 输出）
  const totalTokens = responses.reduce(
    (acc, r) => acc + r.tokens_input + r.tokens_output, 0
  );

  // ────── 菜单外部点击关闭 ──────
  const updateMenuPosition = useCallback(() => {
    const button = menuButtonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const margin = 8;
    const menuWidth = menuPopupRef.current?.offsetWidth || 220;
    const menuHeight = menuPopupRef.current?.offsetHeight || 0;
    const left = Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin));
    const belowTop = rect.bottom + 4;
    const top = menuHeight > 0 && belowTop + menuHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - menuHeight - 4)
      : belowTop;

    setMenuPosition({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    document.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      document.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      // 点击菜单容器外部 → 关闭菜单并重置删除确认
      const target = e.target as globalThis.Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !menuPopupRef.current?.contains(target)
      ) {
        setMenuOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // ────── 编辑操作 ──────

  /** startEdit — 进入编辑模式，光标定位到文本末尾 */
  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setEditContent(node.content);
    setEditing(true);
    // 延迟聚焦并将光标移至末尾
    setTimeout(() => {
      if (editRef.current) {
        editRef.current.focus();
        editRef.current.setSelectionRange(
          editRef.current.value.length,
          editRef.current.value.length
        );
      }
    }, 50);
  };

  /** cancelEdit — 取消编辑，清空临时内容 */
  const cancelEdit = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setEditing(false);
    setEditContent('');
  };

  const patchNodeContentInTree = useCallback((nextContent: string) => {
    useAppStore.setState((prev: any) => {
      const tree = prev.rootTree ? JSON.parse(JSON.stringify(prev.rootTree)) : [];
      const patchNode = (nodes: any[]): boolean => {
        for (const n of nodes) {
          if (n.id === node.id) {
            n.content = nextContent;
            return true;
          }
          if (n.children?.length && patchNode(n.children)) return true;
        }
        return false;
      };
      patchNode(tree);
      return { rootTree: tree };
    });
  }, [node.id]);

  /** saveEdit — 保存编辑内容；逻辑节点只改内容，普通节点保存后重跑 */
  const saveEditAndRerun = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const trimmed = editContent.trim();
    if (!trimmed) return;
    if (!isLogicalNode && rerunModelIds.length === 0) return;
    setEditing(false);
    if (isLogicalNode) {
      try {
        await api.updateNode(node.id, { content: trimmed });
        patchNodeContentInTree(trimmed);
      } catch (err) {
        console.error('修改逻辑节点内容失败:', err);
      }
    } else {
      await rerunNode(node.id, trimmed, rerunModelIds);
    }
  };

  /** handleEditKeyDown — 编辑区键盘事件：Enter 保存重跑，Escape 取消 */
  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      saveEditAndRerun();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  // ────── 删除操作（两步确认） ──────

  /** handleDelete — 第一次点击改为确认态，第二次确认后执行删除 */
  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) {
      // 第一次点击：进入确认状态
      setConfirmDelete(true);
      return;
    }
    // 第二次点击：执行删除
    setMenuOpen(false);
    setConfirmDelete(false);
    await deleteNode(node.id);
  };

  // ────── 重跑（不修改问题内容） ──────

  /** handleRerun — 直接用原问题内容重跑 */
  const handleRerun = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    rerunNode(node.id, undefined, rerunModelIds);
  };

  /** handleFocusNode — 切换全局聚焦到当前节点 */
  const handleFocusNode = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    focusNode(node.id);
  };

  /** handleMenuToggleCollapse — 从菜单切换当前节点折叠状态 */
  const handleMenuToggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canCollapse) return;
    setMenuOpen(false);
    toggleCollapse(node.id);
  };

  /** handleMenuToggleCollapseWithDescendants — 从菜单切换当前节点及所有子节点折叠状态 */
  const handleMenuToggleCollapseWithDescendants = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canCollapse) return;
    const newCollapsed = !collapsedSet.has(node.id);
    setMenuOpen(false);
    toggleCollapse(node.id);
    setDescendantsCollapse(node.id, newCollapsed);
  };

  /** handleToggleImmersive — 隐藏/恢复当前节点的追问分支 */
  const handleToggleImmersive = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    toggleImmersive(node.id);
  };

  // ────── 下钻当前节点 ──────
  /** requestDrillIntoNode — 发起 Workflowy 式相机下钻；折叠卡片先展开再移动视角。 */
  const requestDrillIntoNode = () => {
    const dispatchDrill = () => {
      window.dispatchEvent(new CustomEvent('megaform:drill-node', {
        detail: { nodeId: node.id },
      }));
    };

    if (selfCollapsed && canCollapse) {
      toggleCollapse(node.id);
      window.setTimeout(dispatchDrill, 220);
      return;
    }

    dispatchDrill();
  };

  const descCount = countDescendants(node);                // 后代总数
  const showResponses = !hideResponses || isStreaming;      // 流式中即使折叠也显示
  const questionDisplayText = selfCollapsed && node.summary ? node.summary : node.content;
  const collapsedFollowupDisplayText = node.summary || truncateTextWithEllipsis(node.content, 10);

  const renderQuestionText = (text: string) => {
    if (!questionSearchHit?.query) return text;
    const idx = text.toLocaleLowerCase().indexOf(questionSearchHit.query.toLocaleLowerCase());
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <span className="search-hit-anchor" data-search-hit={questionSearchHit.hitId}>
          {text.slice(idx, idx + questionSearchHit.query.length)}
        </span>
        {text.slice(idx + questionSearchHit.query.length)}
      </>
    );
  };

  return (
    <div className={`node-card${node.relation === 'followup' ? ' node-followup' : ''}${selfCollapsed ? ' is-collapsed' : ''}${isLogicalNode ? ' node-logical' : ''}${entering ? (node.relation === 'followup' ? ' node-entering-followup' : ' node-entering-progression') : ''}`} data-scroll-anchor={node.id} data-node-card-id={node.id}>
      {/* ────── 问题区（始终可见） ────── */}
      <div
        className="question-block"
        data-question-anchor={node.id}
      >
        {/* 折叠箭头：有内容时始终显示交互按钮，旋转状态反映当前是否折叠 */}
        {canCollapse && (
          <button
            className={`collapse-toggle${selfCollapsed ? ' is-rotated' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              handleToggle();
            }}
            title={selfCollapsed ? t('clickExpand') : t('clickCollapse')}
          >
            <ChevronDown size={18} />
          </button>
        )}

        {/* ── 编辑模式 vs 摘要编辑 vs 展示模式 ── */}
        {editing ? (
          /* 编辑态：textarea + 操作按钮 */
          <div className="question-edit-area" onClick={(e) => e.stopPropagation()}>
            <textarea
              ref={editRef}
              className="question-edit-input"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
              rows={Math.min(8, Math.max(2, editContent.split('\n').length))}
            />
            <div className="question-edit-actions">
              <button
                className="edit-btn edit-save"
                onClick={saveEditAndRerun}
                disabled={sendingMessage || !editContent.trim() || (!isLogicalNode && rerunModelIds.length === 0)}
              >
                {isLogicalNode ? t('saveChanges') : t('saveAndRerun')}
              </button>
              <button
                className="edit-btn edit-cancel"
                onClick={cancelEdit}
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : summaryEditing ? (
          /* 摘要编辑态 */
          <div className="question-edit-area" onClick={(e) => e.stopPropagation()}>
            <textarea
              ref={summaryRef}
              className="question-edit-input"
              value={summaryText}
              onChange={(e) => setSummaryText(e.target.value)}
              onKeyDown={handleSummaryKeyDown}
              placeholder={t('summaryCollapsedPlaceholder')}
              rows={Math.min(3, Math.max(1, summaryText.split('\n').length))}
            />
            <div className="question-edit-actions">
              <button className="edit-btn edit-save" onClick={saveSummary}>
                {t('saveSummary')}
              </button>
              <button className="edit-btn edit-cancel" onClick={() => setSummaryEditing(false)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : (
          /* 展示态：折叠时有摘要则显示摘要，否则显示问题 */
          <div className="question-display" onDoubleClick={requestDrillIntoNode} title={t('focusNodeHint')}>
            <div className="question-text">
              {selfCollapsed && followupQuote ? (
                <>
                  <ReferencePreview text={followupQuote} />
                  <MoveRight className="collapsed-reference-arrow" size={13} aria-hidden="true" />
                  {renderQuestionText(collapsedFollowupDisplayText)}
                </>
              ) : (
                renderQuestionText(questionDisplayText)
              )}
            </div>

            {/* ── 折叠信息指示（自身折叠时显示） ── */}
            {hideResponses && !isStreaming && (
              <span className="collapsed-info">
                {responses.length > 0 && (
                  <span className="collapsed-info-count">{responses.length} {t('replies')}</span>
                )}
                {modelChips.length > 0 && (
                  <span className="collapsed-info-models">
                    {/* 最多显示 3 个模型标签，超出部分显示 +N */}
                    {modelChips.slice(0, 3).map((name, i) => (
                      <span key={i} className="collapsed-model-chip">{name}</span>
                    ))}
                    {modelChips.length > 3 && (
                      <span className="collapsed-model-chip">+{modelChips.length - 3}</span>
                    )}
                  </span>
                )}
                {totalTokens > 0 && (
                  <span className="collapsed-info-tokens">
                    {totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tok
                  </span>
                )}
              </span>
            )}

            {/* 操作按钮：展开态贴在正文最后一行右侧；折叠态保持紧凑行内显示 */}
            {!isStreaming && (
              <span className="question-actions">
                <span className="node-menu-container" ref={menuRef}>
                  <button
                    ref={menuButtonRef}
                    className="node-menu-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(!menuOpen);
                      setConfirmDelete(false); // 每次打开/关闭菜单时重置删除确认态
                    }}
                    title={t('nodeActions')}
                  >
                    <Ellipsis size={18} />
                  </button>
                  {menuOpen && createPortal(
                    <div
                      className="node-menu"
                      ref={menuPopupRef}
                      style={{
                        position: 'fixed',
                        top: menuPosition.top,
                        left: menuPosition.left,
                        right: 'auto',
                        zIndex: 10000,
                      }}
                    >
                      {/* 聚焦当前节点 */}
                      <button className="menu-item" onClick={handleFocusNode}>
                        <Crosshair size={14} /> {t('focusNode')}
                      </button>
                      {/* 折叠当前节点 */}
                      <button className="menu-item" onClick={handleMenuToggleCollapse} disabled={!canCollapse}>
                        <ChevronDown size={14} /> {t('toggleCollapse')}
                      </button>
                      {/* 折叠当前节点及所有子节点 */}
                      <button className="menu-item" onClick={handleMenuToggleCollapseWithDescendants} disabled={!canCollapse}>
                        <ChevronsUpDown size={14} /> {t('toggleCollapseDescendants')}
                      </button>
                      {/* 沉浸式浏览：有追问子节点时显示 */}
                      {hasFollowupChildren && !hideResponses && (
                        <button
                          className={`menu-item ${isImmersive ? 'menu-item-active' : ''}`}
                          onClick={handleToggleImmersive}
                          title={t('immersiveBrowse')}
                        >
                          <BookOpenText size={14} /> {isImmersive ? t('exitImmersiveBrowse') : t('immersiveBrowseShort')}
                        </button>
                      )}
                      <div className="menu-divider" />
                      {/* 编辑摘要 */}
                      <button className="menu-item" onClick={startSummaryEdit}>
                        <FileText size={14} /> {node.summary ? t('editSummary') : t('addSummary')}
                      </button>
                      <button
                        className="menu-item"
                        onClick={handleAutoSummary}
                        disabled={!summaryModelId || summaryGenerating}
                        title={!summaryModelId ? t('autoSummaryModelRequired') : t('autoSummary')}
                      >
                        <Sparkles size={14} /> {summaryGenerating ? t('autoSummaryGenerating') : t('autoSummary')}
                      </button>
                      {isLogicalNode ? (
                        <button
                          className="menu-item"
                          onClick={startEdit}
                        >
                          <Pencil size={14} /> {t('editContent')}
                        </button>
                      ) : (
                        <>
                          {/* 编辑并重跑 */}
                          <button
                            className="menu-item"
                            onClick={startEdit}
                          >
                            <Pencil size={14} /> {t('editAndRerun')}
                          </button>
                          {/* 重跑（不修改问题内容） */}
                          <button
                            className="menu-item"
                            onClick={handleRerun}
                            disabled={sendingMessage || rerunModelIds.length === 0}
                          >
                            <RefreshCcw size={14} /> {t('rerunWithoutEdit')}
                          </button>
                        </>
                      )}
                      <div className="menu-divider" />
                      {/* 删除节点（两步确认） */}
                      <button
                        className={`menu-item menu-item-danger ${confirmDelete ? 'confirm-active' : ''}`}
                        onClick={handleDelete}
                      >
                        {confirmDelete
                          ? hasChildren
                            ? <><CircleAlert size={14} />{t('confirmDeleteChildren', { count: descCount })}</>
                            : <><CircleAlert size={14} />{t('confirmDelete')}</>
                          : <><Trash size={14} /> {t('deleteNode')}</>
                        }
                      </button>
                    </div>,
                    document.body,
                  )}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* ────── 内容区（回复 + 子节点） ────── */}
      <div className="node-content-wrapper">
        <div className="node-content-inner">
          {/* 折叠动画容器：grid 1fr ↔ 0fr 收放 */}
          {(showResponses && (hasResponses || hasStreamingResponses || (isStreaming && !hasResponses && !hasStreamingResponses))) && (
            <div className={`node-responses-collapsible${showResponses ? '' : ' collapsed'}`}>
              <div className="node-responses-collapsible-inner">
                {/* 回答区：展示 ResponseArea 组件 */}
                {(hasResponses || hasStreamingResponses) && (
                  <div className="node-responses-section">
                    <ResponseArea
                      nodeId={node.id}
                      responses={responses}
                      followupChildren={responseFollowupChildren}
                      immersive={isImmersive}
                      streamingResponses={hasStreamingResponses ? nodeStreamingResponses : undefined}
                      isStreamingNode={isStreaming}
                      suppressModelChipAnimation={suppressEnterAnimation}
                    />
                  </div>
                )}

                {/* 流式中尚无回复数据时的加载占位 */}
                {isStreaming && !hasResponses && !hasStreamingResponses && (
                  <div className="node-responses-section">
                    <div className="streaming-loading">
                      <span style={{ fontSize: 12, color: 'var(--megaform-text-secondary)' }}>
                        {t('waitingModel')}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Progression 子节点（推演链，同级不缩进） */}
          {!selfCollapsed && sortedProgressionChildren.length > 0 && (
            <div className="progression-children">
              {sortedProgressionChildren.map(child => (
                <NodeCard
                  key={child.id}
                  node={child}
                  depth={depth}
                  suppressEnterAnimation={suppressEnterAnimation}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 折叠态：所有子节点独立排列在卡片下方，先追问后推演 */}
      {selfCollapsed && collapsedChildren.length > 0 && (
        <div className="collapsed-children">
          {collapsedChildren.map(child => (
            <NodeCard
              key={child.id}
              node={child}
              depth={depth + 1}
              suppressEnterAnimation={suppressEnterAnimation}
            />
          ))}
        </div>
      )}
    </div>
  );
}
