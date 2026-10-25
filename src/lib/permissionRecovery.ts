import { api } from "@/lib/tauri";
import { t } from "@/lib/i18n";
import { tip } from "@/lib/tip";

/** 等价系统设置里的 −：重建输入监控条目后引导用户重新授权。 */
export async function resetInputMonitoringAndReopen() {
  try {
    await api.resetInputMonitoring();
    tip("ok", t("已重置授权条目 · 请重新勾选 Toskr 后点「重启」"));
  } catch (error) {
    tip("warn", t("自动重置失败（{error}）· 请手动删除条目后重加", { error: String(error) }));
  }
  void api.openPrivacySettings("input-monitoring");
}
