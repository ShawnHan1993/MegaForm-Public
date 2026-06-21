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
import { useState, useRef, useEffect, useLayoutEffect, useMemo, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/appStore';
import { getThinkingDepthClass, getThinkingLevels, type ThinkingLevel } from '../data/thinkingPresets';
import type { Node as RootNode } from '../types';
import { SearchOutlined } from '@ant-design/icons';
import { Activity, X, AlertTriangle, ArrowUp, UserRound, FileUp, Link2, Image as ImageIcon, Camera, Plus } from 'lucide-react';
import { localizeThinkingDescription, localizeThinkingLabel, useLanguage, useT } from '../i18n';
import { fileToDataUrl, isSupportedImageFile, modelSupportsImageInput, type ImageAttachment } from '../utils/multimodal';

const INPUT_MAX_HEIGHT = 200;  // textarea 最高上限 px
type ThinkingPopoverPosition = { left: number; bottom: number } | null;
type UploadFormPosition = { right: number; bottom: number } | null;
type DocumentAttachment =
  | { kind: 'file'; file: File; name: string; documentType: 'pdf' | 'markdown' }
  | { kind: 'pdf_url'; url: string; name: string; documentType: 'pdf' };

export default function InputBar() {
  const language = useLanguage();
  const t = useT();
  const models = useAppStore(s => s.models);
  const selectedModelIds = useAppStore(s => s.selectedModelIds);
  // 过滤已删除的模型（deleted 为1表示标记为删除）
  const visibleModels = useMemo(() => {
    const selectedIds = new Set(selectedModelIds);
    return models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => model.deleted !== 1)
      .sort((a, b) => {
        const selectedDiff = Number(selectedIds.has(b.model.id)) - Number(selectedIds.has(a.model.id));
        if (selectedDiff !== 0) return selectedDiff;
        const usageDiff = (b.model.recent_usage_count || 0) - (a.model.recent_usage_count || 0);
        if (usageDiff !== 0) return usageDiff;
        const tokenDiff = (b.model.recent_token_usage || 0) - (a.model.recent_token_usage || 0);
        if (tokenDiff !== 0) return tokenDiff;
        return a.index - b.index;
      })
      .map(({ model }) => model);
  }, [models, selectedModelIds]);
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
  const mineruApiKeyConfigured = useAppStore(s => s.mineruApiKeyConfigured);
  const importPdf = useAppStore(s => s.importPdf);
  const importPdfUrl = useAppStore(s => s.importPdfUrl);
  const importMarkdown = useAppStore(s => s.importMarkdown);

  const [input, setInput] = useState('');
  const [thinkingPopoverFor, setThinkingPopoverFor] = useState<string | null>(null);
  const [thinkingPopoverPosition, setThinkingPopoverPosition] = useState<ThinkingPopoverPosition>(null);
  const [uploadFormOpen, setUploadFormOpen] = useState(false);
  const [uploadFormPosition, setUploadFormPosition] = useState<UploadFormPosition>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [documentAttachment, setDocumentAttachment] = useState<DocumentAttachment | null>(null);
  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null);
  const [imageError, setImageError] = useState('');
  const [uploadUrl, setUploadUrl] = useState('');
  const [uploadError, setUploadError] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const uploadFormRef = useRef<HTMLDivElement>(null);
  const modelPillRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const previousModelPillLayoutRef = useRef<{
    rects: Map<string, DOMRect>;
    order: Map<string, number>;
    selectedIds: Set<string>;
  } | null>(null);
  const modelLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextModelToggleRef = useRef(false);
  const suppressNextThinkingClickRef = useRef(false);
  const thinkingPopoverTriggerRef = useRef<HTMLElement | null>(null);
  const ignoreModelPillsScrollUntilRef = useRef(0);

  // 侧边栏"新问题树"触发时自动聚焦输入框
  const inputFocusTrigger = useAppStore(s => s.inputFocusTrigger);
  useEffect(() => {
    if (inputFocusTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [inputFocusTrigger]);

  useEffect(() => {
    return () => {
      if (modelLongPressTimerRef.current) {
        clearTimeout(modelLongPressTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const currentRects = new Map<string, DOMRect>();
    const currentOrder = new Map<string, number>();

    visibleModels.forEach((model, index) => {
      const element = modelPillRefs.current.get(model.id);
      if (!element) return;
      currentRects.set(model.id, element.getBoundingClientRect());
      currentOrder.set(model.id, index);
    });

    const previousLayout = previousModelPillLayoutRef.current;
    const currentSelectedIds = new Set(selectedModelIds);
    if (previousLayout) {
      const selectionChanged =
        previousLayout.selectedIds.size !== currentSelectedIds.size ||
        selectedModelIds.some(id => !previousLayout.selectedIds.has(id));

      if (selectionChanged) {
        visibleModels.forEach((model, index) => {
          const previousIndex = previousLayout.order.get(model.id);
          if (previousIndex === undefined || previousIndex === index) return;

          const element = modelPillRefs.current.get(model.id);
          const previousRect = previousLayout.rects.get(model.id);
          const currentRect = currentRects.get(model.id);
          if (!element || !previousRect || !currentRect) return;

          const deltaX = previousRect.left - currentRect.left;
          if (deltaX === 0) return;

          element.getAnimations().forEach(animation => animation.cancel());
          element.animate(
            [
              { transform: `translateX(${deltaX}px)` },
              { transform: 'translateX(0)' },
            ],
            {
              duration: 320,
              easing: 'cubic-bezier(0.2, 0, 0, 1)',
            },
          );
        });
      }
    }

    previousModelPillLayoutRef.current = {
      rects: currentRects,
      order: currentOrder,
      selectedIds: currentSelectedIds,
    };
  }, [visibleModels, selectedModelIds]);

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
      thinkingPopoverTriggerRef.current = null;
      setThinkingPopoverFor(null);
      setThinkingPopoverPosition(null);
    };
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        !thinkingPopoverTriggerRef.current?.contains(target)
      ) {
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

  useEffect(() => {
    if (!uploadFormOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setUploadFormOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [uploadFormOpen]);

  const updateUploadFormPosition = () => {
    const button = uploadButtonRef.current;
    if (!button || window.innerWidth <= 768) {
      setUploadFormPosition(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    setUploadFormPosition({
      right: Math.max(16, window.innerWidth - rect.right),
      bottom: Math.max(16, window.innerHeight - rect.top + 10),
    });
  };

  useEffect(() => {
    if (!uploadFormOpen) return;
    updateUploadFormPosition();
    window.addEventListener('resize', updateUploadFormPosition);
    window.addEventListener('scroll', updateUploadFormPosition, true);
    return () => {
      window.removeEventListener('resize', updateUploadFormPosition);
      window.removeEventListener('scroll', updateUploadFormPosition, true);
    };
  }, [uploadFormOpen]);

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
    thinkingPopoverTriggerRef.current = isClosing ? null : target;
    if (!isClosing && window.innerWidth <= 768) {
      ignoreModelPillsScrollUntilRef.current = Date.now() + 300;
    }
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
  const isChildProgressionNode = Boolean(
    focusedNode &&
    focusedNode.relation === 'progression' &&
    focusedNode.parent_id,
  );

  const hasImageAttachment = Boolean(imageAttachment);
  const hasDocumentAttachment = Boolean(documentAttachment);

  useEffect(() => {
    if (!isChildProgressionNode) return;
    setUploadFormOpen(false);
    setThinkingPopoverFor(null);
    setThinkingPopoverPosition(null);
    thinkingPopoverTriggerRef.current = null;
  }, [isChildProgressionNode]);

  useEffect(() => {
    if (!hasImageAttachment) return;
    const supportedIds = new Set(visibleModels.filter(modelSupportsImageInput).map(model => model.id));
    const filtered = selectedModelIds.filter(id => supportedIds.has(id));
    if (filtered.length !== selectedModelIds.length) {
      setSelectedModelIds(filtered);
    }
  }, [hasImageAttachment, selectedModelIds, setSelectedModelIds, visibleModels]);

  // V3: 统一发送 — 始终作为聚焦节点的 progression 子节点
  const handleSend = async () => {
    if (isChildProgressionNode) return;
    const text = input.trim() || (imageAttachment ? (language === 'en' ? 'Please answer based on the attached image.' : '请基于附图回答。') : '');
    if (!text) return;
    if (documentAttachment) {
      const attachment = documentAttachment;
      setInput('');
      setDocumentAttachment(null);
      setImageError('');
      if (attachment.kind === 'pdf_url') {
        await submitPdfUrlImport(attachment.url, text);
      } else {
        await submitFileImport(attachment.file, text);
      }
      return;
    }
    if (imageAttachment && selectedModelIds.length === 0) {
      setImageError(language === 'en' ? 'Choose at least one model that supports image input.' : '请选择至少一个支持图片输入的模型');
      return;
    }
    setInput(''); // 立即清空，不等 API 返回
    const attachments = imageAttachment ? [imageAttachment] : undefined;
    setImageAttachment(null);
    setImageError('');

    if (!currentRootId) {
      // 新问题树
      await sendMessage(text, { webSearch: webSearchEnabled, attachments });
    } else if (focusedNode) {
      // 作为聚焦节点的 progression 子节点
      await sendMessage(text, {
        rootId: currentRootId,
        parentId: focusedNode.id,
        relation: 'progression',
        webSearch: webSearchEnabled,
        attachments,
      });
    } else {
      // 有问题树但无聚焦节点（不应发生，安全回退）
      await sendMessage(text, {
        rootId: currentRootId,
        webSearch: webSearchEnabled,
        attachments,
      });
    }
  };

  const filenameFromPdfUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'document.pdf');
      return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
    } catch {
      return 'document.pdf';
    }
  };

  const resetUploadForm = () => {
    setUploadFile(null);
    setUploadUrl('');
    setUploadError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const openUploadForm = () => {
    if (isChildProgressionNode) return;
    if (sendingMessage) return;
    resetUploadForm();
    updateUploadFormPosition();
    setUploadFormOpen(true);
  };

  const submitPdfUrlImport = async (url: string, nodeContent: string) => {
    if (isChildProgressionNode) return;
    if (sendingMessage || !mineruApiKeyConfigured) return;
    const filename = filenameFromPdfUrl(url);

    try {
      if (!currentRootId) {
        await importPdfUrl(url, { filename, cardContent: nodeContent });
      } else if (focusedNode) {
        await importPdfUrl(url, {
          filename,
          rootId: currentRootId,
          parentId: focusedNode.id,
          relation: 'progression',
          cardContent: nodeContent,
        });
      } else {
        await importPdfUrl(url, { filename, rootId: currentRootId, cardContent: nodeContent });
      }
    } catch {
      // Store 已经写入错误状态，这里避免浏览器报未处理 Promise。
    }
  };

  const submitFileImport = async (file: File, nodeContent: string) => {
    if (isChildProgressionNode) return;
    if (!file || sendingMessage) return;
    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
    const isMarkdown = lower.endsWith('.md') || lower.endsWith('.markdown');
    const importer = isPdf ? importPdf : importMarkdown;

    try {
      if (!currentRootId) {
        await importer(file, { cardContent: nodeContent });
      } else if (focusedNode) {
        await importer(file, {
          rootId: currentRootId,
          parentId: focusedNode.id,
          relation: 'progression',
          cardContent: nodeContent,
        });
      } else {
        await importer(file, { rootId: currentRootId, cardContent: nodeContent });
      }
    } catch {
      // Store 已经写入错误状态，这里避免浏览器报未处理 Promise。
    }
  };

  const handleUploadFileSelected = (file?: File | null) => {
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploadFile(file);
    setUploadUrl('');
    setUploadError('');
  };

  const handleImageSelected = async (file?: File | null) => {
    if (!file) return;
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (!isSupportedImageFile(file)) {
      setImageError(language === 'en' ? 'Supported images: PNG, JPEG, WEBP, GIF.' : '支持 PNG、JPEG、WEBP、GIF 图片');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setImageError(language === 'en' ? 'Image must be smaller than 8 MB.' : '图片需小于 8 MB');
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setImageAttachment({
        type: 'image',
        name: file.name || 'image',
        mime_type: file.type || 'image/jpeg',
        data_url: dataUrl,
        size: file.size,
      });
      setDocumentAttachment(null);
      setImageError('');
    } catch {
      setImageError(language === 'en' ? 'Failed to read image.' : '读取图片失败');
    }
  };

  const handleUploadSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const url = uploadUrl.trim();
    const hasFile = Boolean(uploadFile);
    const hasUrl = Boolean(url);

    if (!hasFile && !hasUrl) {
      setUploadError(language === 'en' ? 'Choose a file or enter a PDF link.' : '请选择文件或输入 PDF 链接');
      return;
    }
    if (hasFile && hasUrl) {
      setUploadError(language === 'en' ? 'Use either a file or a PDF link.' : '文件和 PDF 链接只能选择一种');
      return;
    }
    if (hasUrl) {
      if (!/^https?:\/\//i.test(url)) {
        setUploadError(language === 'en' ? 'Enter a valid HTTP(S) PDF link.' : '请输入有效的 HTTP(S) PDF 链接');
        return;
      }
      if (!mineruApiKeyConfigured) {
        setUploadError(language === 'en' ? 'Configure MinerU API key first.' : '请先在配置中填写 MinerU API Key');
        return;
      }
      setDocumentAttachment({
        kind: 'pdf_url',
        url,
        name: filenameFromPdfUrl(url),
        documentType: 'pdf',
      });
      setImageAttachment(null);
      setUploadFormOpen(false);
      resetUploadForm();
      textareaRef.current?.focus();
      return;
    }

    const file = uploadFile!;
    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
    const isMarkdown = lower.endsWith('.md') || lower.endsWith('.markdown');
    if (!isPdf && !isMarkdown) {
      setUploadError(language === 'en' ? 'Supported files: PDF, Markdown.' : '支持 PDF 和 Markdown 文件');
      return;
    }
    if (isPdf && !mineruApiKeyConfigured) {
      setUploadError(language === 'en' ? 'Configure MinerU API key first.' : '请先在配置中填写 MinerU API Key');
      return;
    }
    setDocumentAttachment({
      kind: 'file',
      file,
      name: file.name,
      documentType: isPdf ? 'pdf' : 'markdown',
    });
    setImageAttachment(null);
    setUploadFormOpen(false);
    resetUploadForm();
    textareaRef.current?.focus();
  };

  const toggleModel = (modelId: string) => {
    if (suppressNextModelToggleRef.current) {
      suppressNextModelToggleRef.current = false;
      return;
    }
    if (selectedModelIds.includes(modelId)) {
      setSelectedModelIds(selectedModelIds.filter(id => id !== modelId));
    } else {
      setSelectedModelIds([...selectedModelIds, modelId]);
    }
  };

  const cancelModelLongPress = () => {
    if (!modelLongPressTimerRef.current) return;
    clearTimeout(modelLongPressTimerRef.current);
    modelLongPressTimerRef.current = null;
  };

  const startModelLongPress = (modelId: string, target: HTMLElement, canOpenThinking: boolean) => {
    cancelModelLongPress();
    if (!canOpenThinking || window.innerWidth > 768) return;

    modelLongPressTimerRef.current = setTimeout(() => {
      suppressNextModelToggleRef.current = true;
      toggleThinkingPopover(modelId, target);
      modelLongPressTimerRef.current = null;
    }, 420);
  };

  const openThinkingPopoverFromTouch = (modelId: string, target: HTMLElement) => {
    cancelModelLongPress();
    suppressNextThinkingClickRef.current = true;
    thinkingPopoverTriggerRef.current = target;
    ignoreModelPillsScrollUntilRef.current = Date.now() + 300;
    setThinkingPopoverFor(modelId);
    setThinkingPopoverPosition(getMobilePopoverPosition(target));
  };

  const getModelThinkingLevels = (model: { provider: string; model_name: string }): ThinkingLevel[] | undefined => {
    return getThinkingLevels(model.provider, model.model_name);
  };

  // 输入框提示文字
  const getPlaceholder = () => {
    if (isChildProgressionNode) return t('progressionLockedPlaceholder');
    if (documentAttachment) return language === 'en' ? 'Enter the node-card content for this attachment...' : '输入这个附件的 node-card 内容...';
    if (!currentRootId) return t('inputQuestion');
    if (focusedNode) {
      const snippet = focusedNode.content.slice(0, 20);
      return t('exploreBasedOn', { text: snippet });
    }
    return t('inputNewQuestion');
  };

  return (
    <div className={`input-bar${currentRootId ? ' root-mode' : ''}${isChildProgressionNode ? ' progression-locked' : ''}`}>
      <div className={`input-wrapper${isChildProgressionNode ? ' input-wrapper-locked' : ''}`}>
        <div className="input-textarea-clip">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => {
              if (isChildProgressionNode) return;
              setInput(e.target.value);
            }}
            onKeyDown={e => {
              if (isChildProgressionNode) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                // 跳过输入法（IME）组合态中的 Enter —— 用户还在选字
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={getPlaceholder()}
            disabled={sendingMessage || isChildProgressionNode}
            rows={1}
          />
        </div>

        {!isChildProgressionNode && imageAttachment && (
          <div className="input-attachment-preview">
            <img src={imageAttachment.data_url} alt="" />
            <div className="input-attachment-info">
              <span>{imageAttachment.name}</span>
              <small>{Math.max(1, Math.round(imageAttachment.size / 1024))} KB</small>
            </div>
            <button
              type="button"
              className="input-attachment-remove"
              onClick={() => setImageAttachment(null)}
              aria-label={language === 'en' ? 'Remove image' : '移除图片'}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {!isChildProgressionNode && documentAttachment && (
          <div className="input-attachment-preview document-attachment-preview">
            <span className="input-attachment-doc-icon">
              {documentAttachment.kind === 'pdf_url' ? <Link2 size={18} /> : <FileUp size={18} />}
            </span>
            <div className="input-attachment-info">
              <span>{documentAttachment.name}</span>
              <small>
                {documentAttachment.documentType === 'pdf'
                  ? (language === 'en' ? 'PDF attachment' : 'PDF 附件')
                  : (language === 'en' ? 'Markdown attachment' : 'Markdown 附件')}
              </small>
            </div>
            <button
              type="button"
              className="input-attachment-remove"
              onClick={() => setDocumentAttachment(null)}
              aria-label={language === 'en' ? 'Remove attachment' : '移除附件'}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {!isChildProgressionNode && <div className="input-toolbar">
          {/* 模型选择 */}
          <div
            className={`model-pills${thinkingPopoverFor ? ' has-thinking-popover' : ''}`}
            onScroll={() => {
              cancelModelLongPress();
              if (Date.now() < ignoreModelPillsScrollUntilRef.current) return;
              if (thinkingPopoverPosition) {
                thinkingPopoverTriggerRef.current = null;
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
              const disabledByAttachment = hasDocumentAttachment || (hasImageAttachment && !modelSupportsImageInput(model));

              return (
                <div
                  key={model.id}
                  className="model-pill-wrap"
                  ref={(element) => {
                    if (element) {
                      modelPillRefs.current.set(model.id, element);
                    } else {
                      modelPillRefs.current.delete(model.id);
                    }
                  }}
                >
                  <button
                    className={`model-pill ${isSelected ? 'selected' : ''} ${disabledByAttachment ? 'disabled-by-image' : ''}`}
                    onClick={() => toggleModel(model.id)}
                    disabled={disabledByAttachment}
                    title={disabledByAttachment
                      ? (hasDocumentAttachment
                        ? (language === 'en' ? 'Document imports do not call chat models' : '文档导入不会调用聊天模型')
                        : (language === 'en' ? 'This model does not support image input' : '该模型不支持图片输入'))
                      : undefined}
                    onPointerDown={(e) => {
                      if (e.pointerType === 'mouse') return;
                      startModelLongPress(model.id, e.currentTarget, Boolean(hasThinking && isSelected));
                    }}
                    onPointerUp={cancelModelLongPress}
                    onPointerCancel={cancelModelLongPress}
                    onPointerLeave={cancelModelLongPress}
                    onContextMenu={(e) => {
                      // 右键点击支持思考模式的模型 → 弹出思考深度选择
                      if (hasThinking && isSelected) {
                        e.preventDefault();
                        if (window.innerWidth <= 768 && suppressNextModelToggleRef.current) return;
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
                        onPointerDown={(e) => {
                          if (e.pointerType === 'mouse') return;
                          e.stopPropagation();
                          cancelModelLongPress();
                        }}
                        onPointerUp={(e) => {
                          if (e.pointerType === 'mouse') return;
                          e.preventDefault();
                          e.stopPropagation();
                          openThinkingPopoverFromTouch(model.id, e.currentTarget);
                        }}
                        onTouchEnd={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openThinkingPopoverFromTouch(model.id, e.currentTarget);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressNextThinkingClickRef.current) {
                            suppressNextThinkingClickRef.current = false;
                            return;
                          }
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
                        onPointerDown={(e) => {
                          if (e.pointerType === 'mouse') return;
                          e.stopPropagation();
                          cancelModelLongPress();
                        }}
                        onPointerUp={(e) => {
                          if (e.pointerType === 'mouse') return;
                          e.preventDefault();
                          e.stopPropagation();
                          openThinkingPopoverFromTouch(model.id, e.currentTarget);
                        }}
                        onTouchEnd={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openThinkingPopoverFromTouch(model.id, e.currentTarget);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressNextThinkingClickRef.current) {
                            suppressNextThinkingClickRef.current = false;
                            return;
                          }
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
                    thinkingPopoverPosition ? createPortal(
                      <div
                        className="thinking-popover mobile-fixed"
                        ref={popoverRef}
                        style={{
                          left: thinkingPopoverPosition.left,
                          bottom: thinkingPopoverPosition.bottom,
                        }}
                      >
                        <div className="thinking-popover-title" style={{ display: 'flex', alignItems: 'center' }}><Activity size={14} style={{ marginRight: 4 }} /> {t('thinkingDepth')}</div>
                        {thinkingLevels!.map(level => (
                          <button
                            key={level.budget}
                            className={`thinking-level-btn ${currentBudget === level.budget ? 'active' : ''}`}
                            onClick={() => {
                              setThinkingBudget(model.id, level.budget);
                              thinkingPopoverTriggerRef.current = null;
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
                            thinkingPopoverTriggerRef.current = null;
                            setThinkingPopoverFor(null);
                            setThinkingPopoverPosition(null);
                          }}
                        >
                          <X size={12} style={{ marginRight: 3 }} /> {t('disableThinking')}
                        </button>
                      </div>,
                      document.body,
                    ) : (
                    <div
                      className="thinking-popover"
                      ref={popoverRef}
                    >
                      <div className="thinking-popover-title" style={{ display: 'flex', alignItems: 'center' }}><Activity size={14} style={{ marginRight: 4 }} /> {t('thinkingDepth')}</div>
                      {thinkingLevels!.map(level => (
                        <button
                          key={level.budget}
                          className={`thinking-level-btn ${currentBudget === level.budget ? 'active' : ''}`}
                          onClick={() => {
                            setThinkingBudget(model.id, level.budget);
                            thinkingPopoverTriggerRef.current = null;
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
                          thinkingPopoverTriggerRef.current = null;
                          setThinkingPopoverFor(null);
                          setThinkingPopoverPosition(null);
                        }}
                      >
                        <X size={12} style={{ marginRight: 3 }} /> {t('disableThinking')}
                      </button>
                    </div>
                    )
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
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,text/markdown,.pdf,.md,.markdown"
              style={{ display: 'none' }}
              onChange={e => handleUploadFileSelected(e.target.files?.[0])}
            />
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={e => handleImageSelected(e.target.files?.[0])}
            />
            <button
              ref={uploadButtonRef}
              onClick={openUploadForm}
              disabled={sendingMessage}
              className="send-btn pdf-upload-btn"
              title={language === 'en' ? 'Add attachment' : '添加内容'}
            >
              <Plus size={19} />
            </button>
            <button
              onClick={handleSend}
              disabled={sendingMessage || (!input.trim() && !imageAttachment)}
              className="send-btn"
              title={t('send')}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>}

        {!isChildProgressionNode && uploadFormOpen && (
          <div
            className="upload-form-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setUploadFormOpen(false);
            }}
          >
            <div
              className="upload-form-panel"
              ref={uploadFormRef}
              role="dialog"
              aria-modal="true"
              style={uploadFormPosition ? {
                right: uploadFormPosition.right,
                bottom: uploadFormPosition.bottom,
              } : undefined}
            >
              <div className="upload-form-header">
                <div className="upload-form-title">
                  <Plus size={15} />
                  <span>{language === 'en' ? 'Add content' : '添加内容'}</span>
                </div>
                <button
                  type="button"
                  className="upload-form-close"
                  onClick={() => setUploadFormOpen(false)}
                  aria-label={language === 'en' ? 'Close' : '关闭'}
                >
                  <X size={14} />
                </button>
              </div>

              <form className="upload-form-body" onSubmit={handleUploadSubmit}>
                <div className="upload-action-grid">
                  <button
                    type="button"
                    className={`upload-action-tile ${uploadFile ? 'active' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <span className="upload-source-icon"><FileUp size={15} /></span>
                    <span className="upload-action-copy">
                      <span>{language === 'en' ? 'Upload document' : '上传文档'}</span>
                      <small>{uploadFile ? uploadFile.name : (language === 'en' ? 'PDF or Markdown' : 'PDF 或 Markdown')}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="upload-action-tile"
                    onClick={() => {
                      setUploadFormOpen(false);
                      imageInputRef.current?.click();
                    }}
                  >
                    <span className="upload-source-icon"><ImageIcon size={15} /></span>
                    <span className="upload-action-copy">
                      <span>{language === 'en' ? 'Add image' : '添加图片'}</span>
                      <small>{language === 'en' ? 'Attach to input' : '作为输入内容'}</small>
                    </span>
                  </button>
                  <label className="upload-action-tile upload-camera-action">
                    <span className="upload-source-icon"><Camera size={15} /></span>
                    <span className="upload-action-copy">
                      <span>{language === 'en' ? 'Take photo' : '拍照'}</span>
                      <small>{language === 'en' ? 'Mobile camera' : '手机相机'}</small>
                    </span>
                    <input
                      className="upload-action-native-input"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={async e => {
                        await handleImageSelected(e.target.files?.[0]);
                        e.currentTarget.value = '';
                        setUploadFormOpen(false);
                      }}
                    />
                  </label>
                </div>

                <div className={`upload-source-box ${uploadUrl.trim() ? 'active' : ''}`}>
                  <span className="upload-source-icon"><Link2 size={15} /></span>
                  <span className="upload-source-main">
                    <span className="upload-source-label">{language === 'en' ? 'PDF link' : 'PDF 链接'}</span>
                    <input
                      value={uploadUrl}
                      onChange={e => {
                        setUploadUrl(e.target.value);
                        if (e.target.value.trim()) setUploadFile(null);
                        setUploadError('');
                      }}
                      placeholder="https://arxiv.org/pdf/1706.03762"
                    />
                  </span>
                </div>

                {uploadError && (
                  <div className="upload-form-error">
                    <AlertTriangle size={12} />
                    <span>{uploadError}</span>
                  </div>
                )}

                <div className="upload-form-actions">
                  <button
                    type="button"
                    className="upload-form-secondary"
                    onClick={() => setUploadFormOpen(false)}
                  >
                    {language === 'en' ? 'Cancel' : '取消'}
                  </button>
                  <button type="submit" className="upload-form-primary" disabled={sendingMessage}>
                    {language === 'en' ? 'Import' : '导入'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {(error || imageError) && (
          <div className="input-error">
            <span className="input-error-text"><AlertTriangle size={12} /> {imageError || error}</span>
            <button
              onClick={() => {
                setImageError('');
                clearError();
              }}
              className="input-error-close"
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
