let pendingSave: Promise<void> = Promise.resolve();

export function registerPrivacySettingsSave(save: Promise<void>) {
  pendingSave = save;
  // 保留失败状态供扫描方读取，同时避免尚无扫描等待时的未处理拒绝。
  void save.catch(() => {});
}

export async function waitForPrivacySettingsSave() {
  let observed: Promise<void>;
  do {
    observed = pendingSave;
    await observed;
  } while (observed !== pendingSave);
}
