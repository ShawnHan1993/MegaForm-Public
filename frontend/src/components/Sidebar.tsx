/**
 * Sidebar — 侧边栏组件
 * 
 * 职责：
 * - 展示问题树列表（按置顶/更新时间排序）
 * - 支持搜索聊天记录
 * - 新问题树按钮（重置当前问题树 + 聚焦输入框）
 * - 问题操作：切换、删除、置顶/取消置顶
 * - 配置入口按钮
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../api/client';
import { Pin, PinOff, X, Pencil, Search, MessageSquare, Folder, Settings } from 'lucide-react';
import { getLanguage, tr, useT } from '../i18n';

// ── 时间格式化 ──

/** ISO 时间戳 → 相对时间（如 "3小时前"、"2天前"、"刚刚"） */
function formatRelative(iso: string): string {
  const language = getLanguage();
  const now = Date.now();
  const then = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const diff = now - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return tr('justNow', undefined, language);
  const min = Math.floor(sec / 60);
  if (min < 60) return tr('minutesAgo', { count: min }, language);
  const hr = Math.floor(min / 60);
  if (hr < 24) return tr('hoursAgo', { count: hr }, language);
  const day = Math.floor(hr / 24);
  if (day < 30) return tr('daysAgo', { count: day }, language);
  const mon = Math.floor(day / 30);
  return tr('monthsAgo', { count: mon }, language);
}

/** ISO 时间戳 → 绝对日期（如 "2026-05-04 16:30"） */
function formatAbsolute(iso: string): string {
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  onConfigClick: () => void;
  onRootSelect: () => void;
}

export default function Sidebar({ onConfigClick, onRootSelect }: Props) {
  const t = useT();
  const roots = useAppStore(s => s.roots);
  const pinnedRoots = roots.filter(root => root.pinned);
  const unpinnedRoots = roots.filter(root => !root.pinned);
  const maxRootNodeCount = useMemo(
    () => Math.max(1, ...roots.map(root => root.node_count ?? 0)),
    [roots],
  );
  const currentRootId = useAppStore(s => s.currentRootId);
  const openRoot = useAppStore(s => s.openRoot);
  const deleteRoot = useAppStore(s => s.deleteRoot);
  const pinRoot = useAppStore(s => s.pinRoot);
  const triggerInputFocus = useAppStore(s => s.triggerInputFocus);
  const resetRoot = useAppStore(s => s.resetRoot);
  // 本地搜索状态
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  // ── 摘要编辑状态 ──
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [editingSummaryText, setEditingSummaryText] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  /** 自动聚焦编辑框 */
  useEffect(() => {
    if (editingSummaryId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSummaryId]);

  /** 保存摘要 */
  const saveSummary = async (rootId: string) => {
    const text = editingSummaryText.trim();
    setEditingSummaryId(null);
    try {
      await api.updateRoot(rootId, { summary: text } as any);
      // 乐观更新本地 roots 列表
      const store = useAppStore.getState();
      store.fetchRoots();
    } catch {
      // 静默失败，下次 fetchRoots 会同步
    }
  };

  /** 处理搜索：输入 ≥ 2 个字符时向后端发起搜索请求 */
  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (q.trim().length < 2) {
      setSearchResults([]);
      setShowSearch(false);
      return;
    }
    try {
      const results = await api.search(q);
      setSearchResults(results);
      setShowSearch(true);
    } catch {
      setSearchResults([]);
    }
  };

  /** 删除问题树（带确认） */
  const handleDeleteRoot = async (e: React.MouseEvent, rootId: string) => {
    e.stopPropagation();
    if (confirm(t('deleteRootConfirm'))) {
      await deleteRoot(rootId);
    }
  };

  /** 切换置顶状态 */
  const handlePinRoot = async (e: React.MouseEvent, rootId: string, pinned: boolean) => {
    e.stopPropagation();
    await pinRoot(rootId, !pinned);
  };

  const getRootVolumeLevel = (nodeCount = 0) => {
    if (nodeCount <= 1 || maxRootNodeCount <= 1) return 1;
    const normalized = Math.log(nodeCount) / Math.log(maxRootNodeCount);
    return Math.min(3, Math.max(1, Math.ceil(normalized * 3)));
  };

  const renderRootItem = (root: typeof roots[number]) => (
    <div
      key={root.id}
      className={`root-item root-volume-${getRootVolumeLevel(root.node_count)} ${root.id === currentRootId ? 'active' : ''} ${root.pinned ? 'pinned' : ''}`}
      onClick={() => { openRoot(root.id); window.history.pushState(null, '', '/root/' + root.id); onRootSelect(); }}
    >
      <div className="root-item-main">
        {/* 有摘要则用摘要替代根问题，否则显示根问题 */}
        {editingSummaryId === root.id ? (
          <input
            ref={editInputRef}
            className="root-summary-edit"
            value={editingSummaryText}
            onChange={e => setEditingSummaryText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); saveSummary(root.id); }
              if (e.key === 'Escape') { setEditingSummaryId(null); }
            }}
            onBlur={() => saveSummary(root.id)}
            onClick={e => e.stopPropagation()}
            placeholder={t('summaryPlaceholder')}
          />
        ) : (
          <span className="root-title" title={root.content}>
            {root.summary || root.content}
          </span>
        )}
        <span className="root-time" title={formatAbsolute(root.updated_at)}>
          {formatRelative(root.updated_at)}
        </span>
      </div>
      <div className="root-actions">
        {/* 编辑摘要按钮 */}
        <button
          onClick={e => {
            e.stopPropagation();
            setEditingSummaryId(root.id);
            setEditingSummaryText(root.summary || '');
          }}
          title={t('editSummary')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={e => handlePinRoot(e, root.id, !!root.pinned)}
          title={root.pinned ? t('unpin') : t('pin')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}
        >
          {root.pinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          onClick={e => handleDeleteRoot(e, root.id)}
          title={t('delete')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#ef4444' }}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Header */}
      <div className="sidebar-header">
        <img src="/favicon.svg" alt="MegaForm Logo" style={{ width: 24, height: 24 }} />
        <h1>MegaForm</h1>
      </div>

      <div className="sidebar-primary-actions">
        <button
          className="sidebar-action-btn"
          onClick={() => {
            resetRoot();
            triggerInputFocus();
            onRootSelect();
          }}
        >
          <Pencil size={17} />
          <span>{t('newQuestion')}</span>
        </button>
        <button className="sidebar-action-btn" onClick={onConfigClick}>
          <Settings size={17} />
          <span>{t('settings')}</span>
        </button>
      </div>

      {/* Search */}
      <div className="sidebar-search" style={{ position: 'relative' }}>
        <Search className="sidebar-search-icon" size={15} />
        <input
          type="text"
          placeholder={t('searchChats')}
          value={searchQuery}
          onChange={e => handleSearch(e.target.value)}
          onBlur={() => setTimeout(() => setShowSearch(false), 200)}
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid var(--megaform-border)',
            borderRadius: 8,
            fontSize: 13,
            outline: 'none',
            background: 'var(--megaform-bg)',
          }}
        />
        {showSearch && searchResults.length > 0 && (
          <div className="search-results">
            {searchResults.map((r: any, i: number) => (
              <div
                key={i}
                className="search-result-item"
                onClick={() => {
                  if (r.root_id) { openRoot(r.root_id); window.history.pushState(null, '', '/root/' + r.root_id); onRootSelect(); }
                  setShowSearch(false);
                }}
              >
                <div className="search-result-title">
                  {r.content?.slice(0, 40) || t('searchResult')}
                </div>
                <div className="search-result-snippet">
                  {r.content?.slice(0, 100)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-section-title">
        <Folder size={16} />
        <span>{t('focusQuestions')}</span>
      </div>
      {pinnedRoots.length > 0 && (
        <div className="root-list pinned-root-list">
          {pinnedRoots.map(renderRootItem)}
        </div>
      )}

      <div className="sidebar-section-title">
        <MessageSquare size={16} />
        <span>{t('chats')}</span>
      </div>

      {/* Root List */}
      <div className="root-list">
        {unpinnedRoots.map(renderRootItem)}
      </div>
    </>
  );
}
