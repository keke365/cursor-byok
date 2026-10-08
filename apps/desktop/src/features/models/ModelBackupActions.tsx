import { useRef, useState, type ChangeEvent } from "react";
import type { Model, ModelInput } from "../../shared/api";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { backupIcon, folderOpenIcon, importIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { appStore } from "../../shared/store/appStore";
import { isNativeDesktop, revealBackup, saveModelBackup } from "../../shared/native/modelBackup";

const BACKUP_VERSION = 1;
const LAST_BACKUP_PATH_KEY = "cursor-byok.models.lastBackupPath";

type ModelBackup = {
  version: number;
  models: ModelInput[];
};

export function ModelBackupActions({ models, disabled }: { models: Model[]; disabled: boolean }) {
  const message = useMessage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmingBackup, setConfirmingBackup] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastBackupPath, setLastBackupPath] = useState(() => localStorage.getItem(LAST_BACKUP_PATH_KEY));
  const nativeDesktop = isNativeDesktop();

  const backup = async () => {
    const payload: ModelBackup = {
      version: BACKUP_VERSION,
      models: models.map(modelInput),
    };
    setConfirmingBackup(false);
    setSaving(true);
    try {
      const result = await saveModelBackup(
        `${JSON.stringify(payload, null, 2)}\n`,
        t("选择保存位置"),
        lastBackupPath,
      );
      if (!result.saved) return;
      if (result.path) {
        localStorage.setItem(LAST_BACKUP_PATH_KEY, result.path);
        setLastBackupPath(result.path);
      }
      message(t("已备份 {count} 个模型", { count: models.length }));
    } catch (cause) {
      message(t("保存备份失败：{error}", { error: errorText(cause) }), { duration: 5000 });
    } finally {
      setSaving(false);
    }
  };

  const openLastBackupLocation = async () => {
    if (!lastBackupPath) return;
    try {
      await revealBackup(lastBackupPath);
    } catch (cause) {
      message(t("打开备份位置失败：{error}", { error: errorText(cause) }), { duration: 5000 });
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const payload = parseBackup(await file.text());
      const result = await appStore.importModels(payload.models);
      if (!result) throw new Error(appStore.getSnapshot().error || t("导入失败"));
      message(t("导入完成：新增 {imported} 个模型，跳过 {skipped} 个已存在模型", {
        imported: result.imported,
        skipped: result.skipped,
      }));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause), { duration: 5000 });
    }
  };

  return <>
    <TooltipTrigger label={models.length ? t("备份模型配置") : t("没有可备份的模型")}>
      <button type="button" className={controls.iconButton} aria-label={t("备份模型配置")} disabled={disabled || saving || models.length === 0} onClick={() => setConfirmingBackup(true)}>
        <Icon icon={backupIcon} size="1.1em" />
      </button>
    </TooltipTrigger>
    {nativeDesktop && <TooltipTrigger label={lastBackupPath ? t("打开上次备份位置") : t("尚无上次备份位置")}>
      <button type="button" className={controls.iconButton} aria-label={t("打开上次备份位置")} disabled={disabled || saving || !lastBackupPath} onClick={() => void openLastBackupLocation()}>
        <Icon icon={folderOpenIcon} size="1.1em" />
      </button>
    </TooltipTrigger>}
    <TooltipTrigger label={t("从 JSON 导入模型配置")}>
      <button type="button" className={controls.iconButton} aria-label={t("从 JSON 导入模型配置")} disabled={disabled || saving} onClick={() => inputRef.current?.click()}>
        <Icon icon={importIcon} size="1.1em" />
      </button>
    </TooltipTrigger>
    <input ref={inputRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importBackup(event)} />
    <ConfirmDialog
      open={confirmingBackup}
      title={t("备份模型配置")}
      busy={saving}
      cancelLabel={t("取消")}
      confirmLabel={t("选择保存位置")}
      onCancel={() => setConfirmingBackup(false)}
      onConfirm={() => void backup()}
    >
      <p>{t("备份文件包含模型 API Key，请妥善保管并避免分享给他人。")}</p>
    </ConfirmDialog>
  </>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseBackup(text: string): ModelBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(t("备份文件不是有效的 JSON"));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("备份文件格式无效"));
  const backup = value as Partial<ModelBackup>;
  if (backup.version !== BACKUP_VERSION) throw new Error(t("不支持的备份文件版本"));
  if (!Array.isArray(backup.models) || backup.models.length === 0) throw new Error(t("备份文件中没有模型配置"));
  if (backup.models.some((model) => !model || typeof model !== "object" || Array.isArray(model))) throw new Error(t("备份文件格式无效"));
  return backup as ModelBackup;
}

function modelInput(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return input;
}
