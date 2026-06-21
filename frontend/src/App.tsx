import React, { useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useAppStore } from './store/appStore';
import { api } from './api/client';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import type { CurrentUser } from './types';
import { LANGUAGES, getLanguage, setLanguage, setLanguageFromLocale, useLanguage, useT, type Language } from './i18n';

// 懒加载 — ConfigModal 仅在点击齿轮时出现
const ConfigModal = lazy(() => import('./components/ConfigModal'));

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 500;

function loadSidebarWidth(): number {
  try {
    const saved = localStorage.getItem('megaform-sidebar-width');
    return saved ? Number(saved) : DEFAULT_SIDEBAR_WIDTH;
  } catch { return DEFAULT_SIDEBAR_WIDTH; }
}

/**
 * 从当前 URL pathname 中提取深链接信息
 * 返回 { rootId, nodeId } 或 null
 */
function parseUrlPath(): { rootId: string; nodeId?: string } | null {
  const pathname = window.location.pathname;
  const rootMatch = pathname.match(/^\/root\/([a-f0-9]{12})$/);
  if (rootMatch) return { rootId: rootMatch[1] };
  const nodeMatch = pathname.match(/^\/node\/([a-f0-9]{12})$/);
  if (nodeMatch) return { rootId: '', nodeId: nodeMatch[1] }; // rootId 需要从 API 查询
  return null;
}

/**
 * 根据 URL 深链接执行导航（供初始加载 & popstate 共用）
 */
async function navigateFromUrl(
  openRoot: (id: string, opts?: { markRecent?: boolean }) => Promise<void>,
  focusNode: (id: string) => void,
  fetchRoots: () => Promise<void>,
) {
  const parsed = parseUrlPath();
  if (!parsed) return;

  try {
    if (parsed.nodeId) {
      // /node/:nodeId — 查所属问题树 → 载入 → 聚焦
      const node = await api.getNode(parsed.nodeId);
      if (!node?.root_id) {
        console.error('[deep-link] 节点无 root_id:', parsed.nodeId);
        return;
      }
      await fetchRoots();
      await openRoot(node.root_id, { markRecent: false });
      focusNode(parsed.nodeId);
    } else {
      // /root/:rootId — 直接载入问题树
      await fetchRoots();
      await openRoot(parsed.rootId);
    }
  } catch (e) {
    console.error('[deep-link] 导航失败:', parsed, e);
  }
}

export default function App() {
  const language = useLanguage();
  const t = useT();
  const fetchRoots = useAppStore(s => s.fetchRoots);
  const fetchRecentNodes = useAppStore(s => s.fetchRecentNodes);
  const fetchModels = useAppStore(s => s.fetchModels);
  const fetchWebSearchEnabled = useAppStore(s => s.fetchWebSearchEnabled);
  const openRoot = useAppStore(s => s.openRoot);
  const focusNode = useAppStore(s => s.focusNode);
  const currentRootId = useAppStore(s => s.currentRootId);
  const streamingNodeIds = useAppStore(s => s.streamingNodeIds);
  const [showConfig, setShowConfig] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [authLoading, setAuthLoading] = React.useState(true);
  const [currentUser, setCurrentUser] = React.useState<CurrentUser | null>(null);
  const [authMode, setAuthMode] = React.useState<'local' | 'oauth'>('local');
  const [localMode, setLocalMode] = React.useState(true);
  const [emailAuthEnabled, setEmailAuthEnabled] = React.useState(true);
  const [googleAuthConfigured, setGoogleAuthConfigured] = React.useState(false);
  const [authFormMode, setAuthFormMode] = React.useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = React.useState('');
  const [authPassword, setAuthPassword] = React.useState('');
  const [authDisplayName, setAuthDisplayName] = React.useState('');
  const [authSubmitting, setAuthSubmitting] = React.useState(false);
  const [authError, setAuthError] = React.useState('');

  // ── 可调整侧边栏宽度 ──
  const [sidebarWidth, setSidebarWidth] = React.useState(loadSidebarWidth);
  const [isDragging, setIsDragging] = React.useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  // 拖拽中：follow 鼠标；松手：持久化
  useEffect(() => {
    if (!isDragging) return;

    let currentWidth = dragStartWidth.current;

    const onMove = (e: MouseEvent) => {
      const diff = e.clientX - dragStartX.current;
      currentWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, dragStartWidth.current + diff));
      setSidebarWidth(currentWidth);
    };
    const onUp = () => {
      setIsDragging(false);
      localStorage.setItem('megaform-sidebar-width', String(currentWidth));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then(me => {
        if (cancelled) return;
        setCurrentUser(me.user);
        setAuthMode(me.auth_mode);
        setLocalMode(me.local_mode);
        setEmailAuthEnabled(me.email_auth_enabled);
        setGoogleAuthConfigured(me.google_auth_configured);
        if (me.user?.locale) setLanguageFromLocale(me.user.locale);
      })
      .catch(err => {
        console.error('[auth] 获取当前用户失败:', err);
        if (!cancelled) setCurrentUser(null);
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (authLoading || !currentUser) return;
    fetchRoots();
    fetchRecentNodes();
    fetchModels();
    fetchWebSearchEnabled();
  }, [authLoading, currentUser, fetchRoots, fetchRecentNodes, fetchModels, fetchWebSearchEnabled]);

  // ── URL 深链接：初始加载 & 浏览器前进后退 ──
  const isInitialMount = useRef(true);

  // 初始加载：从 URL 解析并导航
  useEffect(() => {
    if (authLoading || !currentUser) return;
    navigateFromUrl(openRoot, focusNode, fetchRoots).finally(() => {
      isInitialMount.current = false;
    });
  }, [authLoading, currentUser, openRoot, focusNode, fetchRoots]);

  // popstate：浏览器前进/后退时响应
  useEffect(() => {
    const handlePopstate = () => {
      if (isInitialMount.current) return;  // 初始加载尚未完成
      navigateFromUrl(openRoot, focusNode, fetchRoots);
    };
    window.addEventListener('popstate', handlePopstate);
    return () => window.removeEventListener('popstate', handlePopstate);
  }, [openRoot, focusNode, fetchRoots]);

  // 有问题树或正在流式响应时显示聊天区
  const showChatArea = !!currentRootId || streamingNodeIds.size > 0;

  const handleLogout = async (allDevices = false) => {
    try {
      if (allDevices) await api.logoutAll();
      else await api.logout();
      const me = await api.getMe();
      setCurrentUser(me.user);
      setAuthMode(me.auth_mode);
      setLocalMode(me.local_mode);
      setEmailAuthEnabled(me.email_auth_enabled);
      setGoogleAuthConfigured(me.google_auth_configured);
      if (me.user?.locale) setLanguageFromLocale(me.user.locale);
    } catch (e) {
      console.error('[auth] 退出登录失败:', e);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthSubmitting(true);
    try {
      const payload = {
        email: authEmail.trim(),
        password: authPassword,
        display_name: authDisplayName.trim(),
        locale: language,
      };
      const result = authFormMode === 'register'
        ? await api.register(payload)
        : await api.login({ email: payload.email, password: payload.password, locale: payload.locale });
      setCurrentUser(result.user);
      const me = await api.getMe();
      setAuthMode(me.auth_mode);
      setLocalMode(me.local_mode);
      setEmailAuthEnabled(me.email_auth_enabled);
      setGoogleAuthConfigured(me.google_auth_configured);
      if (me.user?.locale) setLanguageFromLocale(me.user.locale);
    } catch (err: any) {
      setAuthError(err?.message || t('authFailed'));
    } finally {
      setAuthSubmitting(false);
    }
  };

  if (authLoading) {
    return <div className="auth-screen">{t('loadingApp')}</div>;
  }

  const handleLanguageChange = (nextLanguage: Language, persistRemote = false) => {
    setLanguage(nextLanguage, { persistRemote });
    setCurrentUser(user => user ? { ...user, locale: nextLanguage } : user);
  };

  if (!currentUser && authMode === 'oauth') {
    return (
      <div className="auth-screen">
        <div className="auth-panel">
          <img src="/favicon.svg" alt="MegaForm Logo" width={36} height={36} />
          <h1>MegaForm</h1>
          <p>{t('loginRequired')}</p>
          <label className="auth-language">
            <span>{t('language')}</span>
            <select value={language} onChange={e => handleLanguageChange(e.target.value as Language)}>
              {LANGUAGES.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          {emailAuthEnabled && (
            <form className="auth-form" onSubmit={handleEmailAuth}>
              <input
                type="email"
                autoComplete="email"
                placeholder={t('email')}
                value={authEmail}
                onChange={e => setAuthEmail(e.target.value)}
                required
              />
              {authFormMode === 'register' && (
                <input
                  type="text"
                  autoComplete="name"
                  placeholder={t('displayNameOptional')}
                  value={authDisplayName}
                  onChange={e => setAuthDisplayName(e.target.value)}
                />
              )}
              <input
                type="password"
                autoComplete={authFormMode === 'register' ? 'new-password' : 'current-password'}
                placeholder={t('passwordMin')}
                value={authPassword}
                onChange={e => setAuthPassword(e.target.value)}
                minLength={8}
                required
              />
              {authError && <div className="auth-error">{authError}</div>}
              <button type="submit" className="auth-primary" disabled={authSubmitting}>
                {authSubmitting ? t('processing') : authFormMode === 'register' ? t('registerAndLogin') : t('emailLogin')}
              </button>
              <button
                type="button"
                className="auth-link-btn"
                onClick={() => {
                  setAuthFormMode(authFormMode === 'register' ? 'login' : 'register');
                  setAuthError('');
                }}
              >
                {authFormMode === 'register' ? t('goLogin') : t('goRegister')}
              </button>
            </form>
          )}
          {googleAuthConfigured && (
            <>
              {emailAuthEnabled && <div className="auth-divider">{t('or')}</div>}
              <div className="auth-actions">
                <button onClick={() => { window.location.href = api.googleLoginUrl(window.location.pathname, getLanguage()); }}>
                  {t('googleLogin')}
                </button>
              </div>
            </>
          )}
          <span>{t('browserKeepsLogin')}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="app-layout"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      {/* Mobile overlay */}
      <div
        className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <Sidebar
          onConfigClick={() => setShowConfig(true)}
          onRootSelect={() => setSidebarOpen(false)}
        />
        {/* Resize handle — right edge of sidebar */}
        <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
      </div>

      {/* Sidebar toggle (desktop) */}
      <button
        className="sidebar-toggle-btn"
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        title={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
      >
        {sidebarCollapsed ? '▶' : '◀'}
      </button>

      {/* Main */}
      <div className={`main-area ${showChatArea ? 'has-chat' : 'is-home'}`}>
        {/* Mobile header */}
        <div className="mobile-header">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, padding: 4 }}
          >
            ☰
          </button>
          <span style={{ display: 'flex', alignItems: 'center', marginLeft: 8, fontSize: 16, fontWeight: 500 }}>
            <img src="/favicon.svg" alt="logo" width={20} height={20} style={{ marginRight: 6 }} />
            MegaForm
          </span>
        </div>

        {showChatArea ? (
          <ChatArea />
        ) : (
          <div className="empty-state">
            <h2>{t('homePrompt')}</h2>
          </div>
        )}
        <InputBar />
      </div>

      {/* Config Modal — 懒加载 */}
      {showConfig && (
        <Suspense fallback={null}>
          <ConfigModal
            currentUser={currentUser}
            localMode={localMode}
            language={language}
            onLanguageChange={(nextLanguage) => handleLanguageChange(nextLanguage, true)}
            onLogout={handleLogout}
            onClose={() => setShowConfig(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
