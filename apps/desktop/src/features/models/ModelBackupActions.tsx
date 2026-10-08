import { useRef, useState, type ChangeEvent } from "react";
import type { Model, ModelInput } from "../../shared/api";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { backupIcon, importIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { appStore } from "../../shared/store/appStore";

const BACKUP_VERSION = 1;
const BACKUP_NAME = "cursor-byok-models.json";

type ModelBackup = {
  version: number;
  models: ModelInput[];
};

export function ModelBackupActions({ models, disabled }: { models: Model[]; disabled: boolean }) {
  const message = useMessage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmingBackup, setConfirmingBackup] = useState(false);

  const backup = () => {
    const payload: ModelBackup = {
      version: BACKUP_VERSION,
      models: models.map(modelInput),
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = BACKUP_NAME;
    link.click();
    URL.revokeObjectURL(url);
    setConfirmingBackup(false);
    message(t("已备份 {count} 个模型", { count: models.length }));
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
      <button type="button" className={controls.iconButton} aria-label={t("备份模型配置")} disabled={disabled || models.length === 0} onClick={() => setConfirmingBackup(true)}>
        <Icon icon={backupIcon} size="1.1em" />
      </button>
    </TooltipTrigger>
    <TooltipTrigger label={t("从 JSON 导入模型配置")}>
      <button type="button" className={controls.iconButton} aria-label={t("从 JSON 导入模型配置")} disabled={disabled} onClick={() => inputRef.current?.click()}>
        <Icon icon={importIcon} size="1.1em" />
      </button>
    </TooltipTrigger>
    <input ref={inputRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importBackup(event)} />
    <ConfirmDialog
      open={confirmingBackup}
      title={t("备份模型配置")}
      cancelLabel={t("取消")}
      confirmLabel={t("继续备份")}
      onCancel={() => setConfirmingBackup(false)}
      onConfirm={backup}
    >
      <p>{t("备份文件包含模型 API Key，请妥善保管并避免分享给他人。")}</p>
    </ConfirmDialog>
  </>;
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
