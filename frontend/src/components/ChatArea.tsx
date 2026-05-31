/**
 * ChatArea — 聊天主区域
 * 
 * 职责：
 * - 面包屑导航：展示当前聚焦节点在问题树中的路径
 * - 冻结区 (FrozenModelBar)：模型 tab 栏冻结在面包屑下方
 * - 聚焦节点切换动画（淡入淡出）
 * - 聚焦渲染：从 rootTree 中取出 focusedNodeId 对应的 NodeCard
 * - 折叠全部/展开全部 切换按钮
 * - 流式新问题树时的临时卡片渲染
 * - 空状态提示
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ListChevronsDownUp } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import NodeCard from './NodeCard';
import FrozenModelBar, { type FrozenEntry } from './FrozenModelBar';
import type { Node, Nut } from '../types';
import { useT } from '../i18n';

const FREEZE_ENTER_OFFSET = 8;
const FREEZE_EXIT_OFFSET = 2;

export default function ChatArea() {
  const t = useT();
  const rootTree = useAppStore(s => s.rootTree);
  const focusedNodeId = useAppStore(s => s.focusedNodeId);
  const getNodePath = useAppStore(s => s.getNodePath);
  const focusNode = useAppStore(s => s.focusNode);
  const currentRootId = useAppStore(s => s.currentRootId);
  const roots = useAppStore(s => s.roots);
  const collapsedSet = useAppStore(s => s.collapsedSet);
  const collapseAll = useAppStore(s => s.collapseAll);
  const streamingNodeIds = useAppStore(s => s.streamingNodeIds);
  const streamingContent = useAppStore(s => s.streamingContent);
  const streamingRelation = useAppStore(s => s.streamingRelation);

  // Derive primary streaming node info for UI (pending placeholder etc.)
  const streamingNodeId = (() => {
    if (streamingNodeIds.size === 0) return null;
    // Prefer pending nodes, then followup nodes, then any
    const arr = [...streamingNodeIds];
    const pending = arr.find(id => id.startsWith('pending-'));
    if (pending) return pending;
    return arr[0];
  })();
  const curStreamContent = streamingNodeId ? (streamingContent[streamingNodeId] || '') : '';
  const curStreamRelation = streamingNodeId ? (streamingRelation[streamingNodeId] || null) : null;
  const treeLoading = useAppStore(s => s.treeLoading);
  const loading = useAppStore(s => s.loading);
  const scrollToNodeId = useAppStore(s => s.scrollToNodeId);
  const clearScrollToNodeId = useAppStore(s => s.clearScrollToNodeId);

  // ── 冻结区状态 ──
  const [frozenEntries, setFrozenEntries] = useState<FrozenEntry[]>([]);

  // ── 移动端面包屑自动显隐 ──
  const [breadcrumbVisible, setBreadcrumbVisible] = useState(true);
  const lastScrollTopRef2 = useRef(0);
  const isMobileRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    isMobileRef.current = mq.matches;
    const handler = (e: MediaQueryListEvent) => { isMobileRef.current = e.matches; };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // FLIP 动画：捕获原 model-bar 芯片位置
  type FlipCaptures = import('./FrozenModelBar').FlipCaptures;
  const flipCapturesRef = useRef<FlipCaptures>({});
  const prevFrozenNodeIdsRef = useRef<Set<string>>(new Set());

  // 获取聚焦节点的路径（用于面包屑）
  const path = focusedNodeId ? getNodePath(focusedNodeId) : [];
  const currentRoot = roots.find(t => t.id === currentRootId);

  // 跳过根节点（第一个 path 节点与根问题重复）
  const breadcrumbNodes = path.length > 1 ? path.slice(1) : [];

  // 判断是否所有可折叠节点都已折叠
  const allNodesCollapsed = (() => {
    if (!rootTree) return false;
    const isLogicalNode = (node: any) => {
      try {
        return JSON.parse(node.meta || '{}').kind === 'logic';
      } catch {
        return false;
      }
    };
    let allCollapsible = 0;
    let allCollapsed = 0;
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        const canCollapse = isLogicalNode(n) || (n.children && n.children.length > 0) || (n.responses && n.responses.length > 0);
        if (canCollapse) {
          allCollapsible++;
          if (collapsedSet.has(n.id)) allCollapsed++;
        }
        if (n.children) walk(n.children);
      }
    };
    walk(rootTree);
    return allCollapsible > 0 && allCollapsible === allCollapsed;
  })();

  // 从 rootTree 中查找指定节点（DFS 递归）
  const findNode = (nodes: any[], id: string): any => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children?.length) {
        const found = findNode(n.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  // 构建节点关系查找表 (id → Node)
  const nodeMapRef = useRef<Record<string, any>>({});

  useEffect(() => {
    const map: Record<string, any> = {};
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        map[n.id] = n;
        if (n.children?.length) walk(n.children);
      }
    };
    if (rootTree) walk(rootTree);
    nodeMapRef.current = map;
  }, [rootTree]);

  // ── 冻结区滚动跟踪 ──
  const handleChatScroll = useCallback(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    const scrollTop = chatArea.scrollTop;
    const viewportTop = scrollTop;

    // 收集所有锚点
    const anchors = chatArea.querySelectorAll<HTMLElement>('[data-frozen-anchor]');
    const entries: FrozenEntry[] = [];
    const nodeMap = nodeMapRef.current;

    // 按 DOM 顺序遍历（即树的前序遍历）
    const anchorList = Array.from(anchors);
    anchorList.forEach((anchor, i) => {
      const nodeId = anchor.dataset.frozenAnchor;
      if (!nodeId) return;
      const node = nodeMap[nodeId];
      if (!node) return;

      // 折叠节点不显示冻结条
      if (collapsedSet.has(nodeId)) return;

      const rect = anchor.getBoundingClientRect();
      const containerRect = chatArea.getBoundingClientRect();
      const anchorTop = rect.top - containerRect.top + scrollTop;

      // 下一个锚点（用于判断当前节点内容是否已完全滚过）
      const nextAnchor = anchorList[i + 1];
      let nextAnchorTop = Infinity;
      if (nextAnchor) {
        const nr = nextAnchor.getBoundingClientRect();
        nextAnchorTop = nr.top - containerRect.top + scrollTop;
      }

      const hasPassedFreezeLine = (id: string, top: number) => {
        const offset = prevFrozenNodeIdsRef.current.has(id)
          ? FREEZE_EXIT_OFFSET
          : FREEZE_ENTER_OFFSET;
        return top < viewportTop - offset;
      };

      // 冻结：锚点顶部稳定滚过视口顶部，且下一个锚点尚未接管
      // 进入和退出使用不同阈值，避免临界点附近来回抖动。
      if (hasPassedFreezeLine(nodeId, anchorTop)) {
        // 如果下一个锚点也已滚过视口，说明当前节点内容已完全离开
        // （最后一个锚点永远保留，直到页面顶部回到它之前）
        const nextNodeId = nextAnchor?.dataset.frozenAnchor;
        if (
          i < anchorList.length - 1 &&
          nextNodeId &&
          hasPassedFreezeLine(nextNodeId, nextAnchorTop)
        ) {
          return; // 跳过：下一个节点已经接管
        }
        // 收集该节点的模型 ID
        const modelIds: string[] = [];
        if (node.responses) {
          for (const resp of node.responses) {
            if (resp.model_id && !modelIds.includes(resp.model_id)) {
              modelIds.push(resp.model_id);
            }
          }
        }


        if (modelIds.length > 0) {
          const entry: FrozenEntry = {
            nodeId,
            question: node.content || '',
            modelIds,
            relation: (node.relation as 'followup' | 'progression') || 'progression',
          };

          // FLIP 捕获：新冻结节点的芯片在原始 model-bar 中的位置
          if (!prevFrozenNodeIdsRef.current.has(nodeId)) {
            const capture: Record<string, DOMRect> = {};
            const chips = anchor.querySelectorAll<HTMLElement>('.model-chip[data-model-id]');
            chips.forEach(chip => {
              const mid = chip.dataset.modelId;
              if (mid) capture[mid] = chip.getBoundingClientRect();
            });
            if (Object.keys(capture).length > 0) {
              flipCapturesRef.current[nodeId] = capture;
            }
          }

          // 推演节点：替换父节点条目（不堆叠）
          if (entry.relation === 'progression' && node.parent_id) {
            const parentIdx = entries.findIndex(e => e.nodeId === node.parent_id);
            if (parentIdx >= 0) {
              entries[parentIdx] = entry;
            } else {
              entries.push(entry);
            }
          } else {
            entries.push(entry);
          }
        }
      }
    });

    setFrozenEntries(prev => {
      if (JSON.stringify(prev) === JSON.stringify(entries)) return prev;
      prevFrozenNodeIdsRef.current = new Set(entries.map(e => e.nodeId));
      return entries;
    });
  }, [collapsedSet]);

  // 监听滚动（兼容桌面和移动端）
  useEffect(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;
    let lastRun = 0;
    const THROTTLE = 100; // ms
    const onScroll = () => {
      const now = Date.now();
      if (now - lastRun < THROTTLE) return;
      lastRun = now;
      handleChatScroll();
    };
    chatArea.addEventListener('scroll', onScroll, { passive: true });
    chatArea.addEventListener('touchmove', onScroll, { passive: true });
    handleChatScroll(); // 初始检测
    return () => {
      chatArea.removeEventListener('scroll', onScroll);
      chatArea.removeEventListener('touchmove', onScroll);
    };
  }, [handleChatScroll]);

  // 问题切换时重置冻结区
  useEffect(() => {
    setFrozenEntries([]);
    prevFrozenNodeIdsRef.current = new Set();
    flipCapturesRef.current = {};
  }, [currentRootId]);

  // ── 移动端：滚动方向检测，控制面包屑显隐 ──
  useEffect(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    const onScroll = () => {
      if (!isMobileRef.current) return;
      const st = chatArea.scrollTop;
      if (st < 5) {
        setBreadcrumbVisible(true);
      } else if (st > lastScrollTopRef2.current + 5) {
        setBreadcrumbVisible(false);
      } else if (st < lastScrollTopRef2.current - 15) {
        setBreadcrumbVisible(true);
      }
      lastScrollTopRef2.current = st;
    };

    chatArea.addEventListener('scroll', onScroll, { passive: true });
    return () => chatArea.removeEventListener('scroll', onScroll);
  }, []);

  // 聚焦节点
  const focusedNode = focusedNodeId && rootTree ? findNode(rootTree, focusedNodeId) : null;

  /** 
   * 查找追问节点在父回复中引用的文字
   */
  const getFollowupQuote = (node: Node): string | null => {
    if (node.relation !== 'followup' || !node.nut_id) return null;
    const parent = node.parent_id && rootTree
      ? findNode(rootTree, node.parent_id)
      : null;
    if (!parent?.responses) return null;
    for (const resp of parent.responses) {
      if (resp.nuts) {
        const nut = resp.nuts.find((n: Nut) => n.id === node.nut_id);
        if (nut?.label) return nut.label;
      }
    }
    return null;
  };

  // 截断文本（中度缩略）
  const truncate = (text: string, maxLen: number): string =>
    text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

  // ── 聚焦切换动画 ──
  const [transitioning, setTransitioning] = useState(false);
  const prevFocusedRef = useRef<string | null>(null);
  const [displayedNode, setDisplayedNode] = useState(focusedNode);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const [breadcrumbHeight, setBreadcrumbHeight] = useState(60); // 默认高度: min-height 40 + padding 10*2
  const prevStreamingNodeIdRef = useRef<string | null>(null);

  // 测量面包屑实际高度，用于 chat-area 的 padding-top 补偿
  useEffect(() => {
    if (breadcrumbRef.current && breadcrumbVisible) {
      const h = breadcrumbRef.current.getBoundingClientRect().height;
      if (h > 0) setBreadcrumbHeight(h);
    }
  }, [breadcrumbVisible, path, currentRoot]);

  useEffect(() => {
    if (focusedNodeId !== prevFocusedRef.current) {
      chatAreaRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      prevFocusedRef.current = focusedNodeId;
      setTransitioning(true);
      const timer = setTimeout(() => {
        setDisplayedNode(focusedNode);
        setTransitioning(false);
      }, 150);
      return () => clearTimeout(timer);
    } else {
      setDisplayedNode(focusedNode);
      setTransitioning(false);
    }
  }, [focusedNodeId, focusedNode]);

  // 追问：流式开始时（null → pending）立即滚动到顶部，展示新节点的问题卡片
  // 推演：不滚动，由 scrollToNodeId 效果精确控制
  useEffect(() => {
    if (streamingNodeId && !prevStreamingNodeIdRef.current) {
      if (curStreamRelation === 'followup') {
        requestAnimationFrame(() => {
          chatAreaRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
    }
    prevStreamingNodeIdRef.current = streamingNodeId;
  }, [streamingNodeId, curStreamRelation]);

  // 推演子节点创建后，滚动到新节点位置（不切换聚焦）
  useEffect(() => {
    if (!scrollToNodeId || !chatAreaRef.current) return;
    // 等 React 渲染完新的 DOM（NodeCard 渲染 + 动画）
    const timer = setTimeout(() => {
      const el = chatAreaRef.current?.querySelector<HTMLElement>(
        `[data-scroll-anchor="${scrollToNodeId}"]`
      );
      if (el) {
        const rect = el.getBoundingClientRect();
        const containerRect = chatAreaRef.current!.getBoundingClientRect();
        const scrollTarget = chatAreaRef.current!.scrollTop + rect.top - containerRect.top;
        chatAreaRef.current!.scrollTo({ top: scrollTarget, behavior: 'smooth' });
      }
      clearScrollToNodeId();
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToNodeId, clearScrollToNodeId]);

  // 是否处于流式输出中
  const isStreamingActive = streamingNodeIds.size > 0;
  // 追问 / 新问题树：展示流式占位卡片 + 滚动到顶
  // 推演（已有父节点）：展示实际树（父节点 + streaming 子节点）
  const showStreamingPlaceholder = isStreamingActive && (
    curStreamRelation === 'followup' || !rootTree || rootTree.length === 0
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1', minHeight: 0 }}>
      {/* Inner wrapper: 面包屑 + 冻结区悬浮在 chat-area 上方，不挤占布局 */}
      <div style={{ position: 'relative', flex: '1', minHeight: 0, display: 'flex', flexDirection: 'column' }}>

      {/* Breadcrumb + Collapse toggle — 悬浮在 chatArea 上方，移动端随下滑淡出 */}
      <div
        ref={breadcrumbRef}
        className={`breadcrumb-wrapper${breadcrumbVisible ? '' : ' hidden'}`}
      >
      <div className="breadcrumb">
        {currentRoot && (
          <span
            className="breadcrumb-item"
            onClick={() => {
              if (rootTree?.length) {
                focusNode(rootTree[0].id);
                window.history.pushState(null, '', '/root/' + currentRootId);
              }
            }}
          >
            {currentRoot.summary || currentRoot.content}
          </span>
        )}
        {breadcrumbNodes.map((node, i) => {
          const isLast = i === breadcrumbNodes.length - 1;
          const isFollowup = node.relation === 'followup';
          const quote = isFollowup ? getFollowupQuote(node) : null;
          return (
            <React.Fragment key={node.id}>
              <span className="breadcrumb-separator">›</span>
              <span
                className={`breadcrumb-item${isLast ? ' current' : ''}${isFollowup && quote ? ' followup' : ''}`}
                onClick={isLast ? undefined : () => { focusNode(node.id); window.history.pushState(null, '', '/node/' + node.id); }}
                title={quote ? `${t('quotePrefix')}: ${quote}` : undefined}
              >
                {isFollowup && quote ? (
                  <>
                    <span className="followup-quote">{truncate(quote, 50)}</span>
                    <span className="followup-question">{truncate(node.summary || node.content, 40)}</span>
                  </>
                ) : (
                  truncate(node.summary || node.content, 40)
                )}
              </span>
            </React.Fragment>
          );
        })}

        {/* 折叠全部按钮（仅折叠，不提供展开） */}
        {currentRootId && rootTree && rootTree.length > 0 && (
          <button
            className={`collapse-all-btn${allNodesCollapsed ? ' is-disabled' : ''}`}
            onClick={allNodesCollapsed ? undefined : collapseAll}
            title={t('collapseAllNodes')}
            disabled={allNodesCollapsed}
          >
            <ListChevronsDownUp size={18} />
          </button>
        )}
      </div>
      </div>

      <FrozenModelBar
        entries={frozenEntries}
        flipCapturesRef={flipCapturesRef}
        top={breadcrumbVisible ? breadcrumbHeight : 0}
        onSelectModel={(nodeId, modelId) => {
          const chatArea = chatAreaRef.current;
          if (!chatArea) return;
          // 等待 React 渲染新模型回复后再滚动
          requestAnimationFrame(() => {
            const anchor = chatArea.querySelector<HTMLElement>(
              `[data-response-anchor="${nodeId}:${modelId}"]`
            );
            if (anchor) {
              const rect = anchor.getBoundingClientRect();
              const containerRect = chatArea.getBoundingClientRect();
              const offset = rect.top - containerRect.top + chatArea.scrollTop;
              chatArea.scrollTo({ top: offset - 8, behavior: 'smooth' });
            }
          });
        }}
      />

      {/* Chat content — 带聚焦切换动画 */}
      <div
        ref={chatAreaRef}
        className="chat-area"
        style={{
          transition: 'opacity 0.15s ease, transform 0.15s ease',
          opacity: transitioning ? 0 : 1,
          transform: transitioning ? 'translateY(6px)' : 'translateY(0)',
          paddingTop: `${20 + (breadcrumbVisible ? breadcrumbHeight : 0)}px`,
        }}
      >
        {showStreamingPlaceholder ? (
          <NodeCard
            node={{
              id: streamingNodeId,
              root_id: currentRootId || '',
              parent_id: null,
              child_order: 0,
              content: curStreamContent,
              relation: 'followup',
              nut_id: null,
              parent_model_id: null,
              search_enabled: null,
              attachments: '[]',
              summary: '',
              pinned: 0,
              archived: 0,
              meta: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              responses: [],
              children: [],
            } as Node}
            depth={0}
          />
        ) : loading || (treeLoading && !displayedNode) ? (
          <div className="empty-state">
            <p>{t('loadingTree')}</p>
          </div>
        ) : displayedNode ? (
          <NodeCard node={displayedNode} depth={0} />
        ) : currentRootId ? (
          <div className="empty-state">
            <p>{t('startBelow')}</p>
          </div>
        ) : (
          <div className="empty-state">
            <p>{t('chooseQuestionStart')}</p>
          </div>
        )}
        {/* 底部空白区：保证最后一个卡片能 scroll 到顶部 */}
        <div className="chat-area-spacer" />
      </div>
      </div>
    </div>
  );
}
