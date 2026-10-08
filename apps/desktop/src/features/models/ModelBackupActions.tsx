import { useId, useRef, useState, type ChangeEvent } from "react";
import { api, type Model, type ModelInput, type ModelImportPolicy, type ModelImportPreview } from "../../shared/api";
import { Modal } from "../../shared/ui/Modal";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { backupIcon, folderOpenIcon, importIcon, trashIcon } from "../../shared/ui/icons";
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
  const importDescriptionId = useId();
  const [confirmingBackup, setConfirmingBackup] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ models: ModelInput[]; preview: ModelImportPreview } | null>(null);
  const [lastBackupPath, setLastBackupPath] = useState(() => localStorage.getItem(LAST_BACKUP_PATH_KEY));
  const nativeDesktop = isNativeDesktop();
  const actionsDisabled = disabled || saving || importing || clearing || pendingImport !== null;

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

  const applyImport = async (inputs: ModelInput[], policy?: ModelImportPolicy) => {
    const result = await appStore.importModels(inputs, policy);
    if (!result) {
      // Another import or model edit may have introduced a conflict after the preview.
      const preview = await api.previewModelImport(inputs);
      if (preview.conflicts.length > 0) {
        setPendingImport({ models: inputs, preview });
      }
      throw new Error(appStore.getSnapshot().error || t("导入失败"));
    }
    setPendingImport(null);
    message(t("导入完成：新增 {imported} 个模型，覆盖 {overwritten} 个模型，跳过 {skipped} 个重复项", {
      imported: result.imported,
      overwritten: result.overwritten,
      skipped: result.skipped,
    }));
  };

  const confirmImport = async (policy: ModelImportPolicy) => {
    if (!pendingImport || importing) return;
    setImporting(true);
    try {
      await applyImport(pendingImport.models, policy);
    } catch (cause) {
      message(errorText(cause), { duration: 5000 });
    } finally {
      setImporting(false);
    }
  };

  const clearModels = async () => {
    const count = models.length;
    setConfirmingClear(false);
    setClearing(true);
    try {
      if (!await appStore.clearModels()) {
        throw new Error(appStore.getSnapshot().error || t("清空失败"));
      }
      message(t("已删除 {count} 个模型", { count }));
    } catch (cause) {
      message(errorText(cause), { duration: 5000 });
    } finally {
      setClearing(false);
    }
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const payload = parseBackup(await file.text());
      const preview = await api.previewModelImport(payload.models);
      if (preview.conflicts.length > 0) {
        setPendingImport({ models: payload.models, preview });
      } else {
        await applyImport(payload.models);
      }
    } catch (cause) {
      message(errorText(cause), { duration: 5000 });
    } finally {
      setImporting(false);
    }
  };

  return <>
    <TooltipTrigger label={models.length ? t("备份模型配置") : t("没有可备份的模型")}>
      <button type="button" className={controls.iconButton} aria-label={t("备份模型配置")} disabled={actionsDisabled || models.length === 0} onClick={() => setConfirmingBackup(true)}>
        <Icon icon={backupIcon} size="1.1em" />
      </button>
    </TooltipTrigger>
    {nativeDesktop && <TooltipTrigger label={lastBackupPath ? t("打开上次备份位置") : t("尚无上次备份位置")}>
      <button type="button" className={controls.iconButton} aria-label={t("打开上次备份位置")} disabled={actionsDisabled || !lastBackupPath} onClick={() => void openLastBackupLocation()}>
        <Icon icon={folderOpenIcon} size="1.1em" />
      </button>
    </TooltipTrigger>}
    <TooltipTrigger label={t("从 JSON 导入模型配置")}>
      <button type="button" className={controls.iconButton} aria-label={t("从 JSON 导入模型配置")} disabled={actionsDisabled} onClick={() => inputRef.current?.click()}>
        <Icon icon={importIcon} size="1.1em" />
      </button>
    </TooltipTrigger>
    <TooltipTrigger label={models.length ? t("清空已添加模型") : t("没有可清空的模型")}>
      <button type="button" className={controls.iconButton} aria-label={t("清空已添加模型")} disabled={actionsDisabled || models.length === 0} onClick={() => setConfirmingClear(true)}>
        <Icon icon={trashIcon} size="1.1em" />
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
    <ConfirmDialog
      open={confirmingClear}
      title={t("清空已添加模型")}
      busy={clearing}
      cancelLabel={t("取消")}
      confirmLabel={t("删除全部")}
      onCancel={() => setConfirmingClear(false)}
      onConfirm={() => void clearModels()}
    >
      <p>{t("确定删除全部 {count} 个已添加模型吗？此操作不可撤销。", { count: models.length })}</p>
    </ConfirmDialog>
    <Modal
      open={pendingImport !== null}
      title={t("发现重复模型")}
      role="alertdialog"
      ariaDescribedBy={importDescriptionId}
      busy={importing}
      onClose={() => setPendingImport(null)}
      closeLabel={t("取消")}
      submitLabel={t("覆盖重复模型")}
      onSubmit={() => void confirmImport("overwrite")}
      secondaryAction={<button type="button" className={controls.primary} disabled={importing} onClick={() => void confirmImport("skip")}>{t("跳过重复模型")}</button>}
    >
      <div id={importDescriptionId}>
        <p>{t("备份共 {total} 个模型，其中 {count} 项与已有模型或备份中的其他项重复。请选择如何处理所有重复项。", { total: pendingImport?.preview.total ?? 0, count: pendingImport?.preview.conflicts.length ?? 0 })}</p>
        <p>{t("实际请求接口地址与模型 ID 相同即视为重复，即使 API Key 或显示名称不同。")}</p>
        <p>{t("覆盖会用备份中的完整配置（包括 API Key）替换重复模型；已有多条相同接口和模型的配置会合并为一条。跳过会保留已有配置。")}</p>
        <p>{t("备份内的重复项：覆盖保留最后一项，跳过保留第一项。其他模型将正常新增；取消不会导入任何模型。")}</p>
      </div>
    </Modal>
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
