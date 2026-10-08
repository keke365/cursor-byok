const BACKUP_NAME = "cursor-byok-models.json";

export function isNativeDesktop() {
  return "__TAURI_INTERNALS__" in window;
}

export async function saveModelBackup(contents: string, title: string, previousPath: string | null): Promise<{ saved: boolean; path: string | null }> {
  if (isNativeDesktop()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string | null>("save_model_backup", { contents, title, previousPath });
    return { saved: path !== null, path };
  }

  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = BACKUP_NAME;
  link.click();
  URL.revokeObjectURL(url);
  return { saved: true, path: null };
}

export async function revealBackup(path: string) {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}
