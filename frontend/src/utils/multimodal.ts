import { PROVIDER_PRESETS, type ModelPreset } from '../data/providerPresets';
import type { ModelConfig } from '../types';

export type ImageAttachment = {
  type: 'image';
  name: string;
  mime_type: string;
  data_url: string;
  size: number;
};

export function parseModelMeta(meta?: string | Record<string, any> | null): Record<string, any> {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    const parsed = JSON.parse(meta);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function modelPresetSupportsImageInput(model?: Partial<ModelPreset> | null): boolean {
  return Boolean((model as any)?.capabilities?.image_input);
}

export function modelSupportsImageInput(model: Partial<ModelConfig> | null | undefined): boolean {
  if (!model) return false;
  const meta = parseModelMeta(model.meta);
  if (meta.capabilities?.image_input === true) return true;
  if (meta.capabilities?.image_input === false) return false;

  const normalizedBaseUrl = (model.base_url || '').trim().replace(/\/+$/, '').toLowerCase();
  const modelName = (model.model_name || '').toLowerCase();
  const providerId = model.provider || '';
  const preset = PROVIDER_PRESETS.find(provider => {
    const providerBaseUrl = provider.base_url.trim().replace(/\/+$/, '').toLowerCase();
    return (
      (normalizedBaseUrl && providerBaseUrl === normalizedBaseUrl) ||
      provider.id === providerId ||
      provider.provider_type === providerId
    );
  });
  const presetModel = preset?.models.find(m => m.model_name.toLowerCase() === modelName);
  if (presetModel) return modelPresetSupportsImageInput(presetModel);

  return false;
}

export function withImageInputCapability<T extends Partial<ModelConfig>>(model: T, enabled: boolean): T {
  const meta = parseModelMeta(model.meta);
  return {
    ...model,
    meta: JSON.stringify({
      ...meta,
      capabilities: {
        ...(meta.capabilities || {}),
        image_input: enabled,
      },
    }),
  };
}

export function isSupportedImageFile(file: File): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(file.type);
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
