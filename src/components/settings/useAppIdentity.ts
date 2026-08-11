import { useEffect, useState } from "react";

import { api } from "@/lib/tauri";

export interface AppIdentityInfo {
  name: string;
  iconUrl: string | null;
}

const appInfoCache = new Map<string, Promise<AppIdentityInfo | null>>();

export interface ResolvedAppIdentity {
  bundleId: string;
  info: AppIdentityInfo;
}

export function appIdentityForCurrentBundle(
  bundleId: string | null | undefined,
  fallbackName: string | null | undefined,
  resolved: ResolvedAppIdentity | null
): AppIdentityInfo | null {
  if (!bundleId) return null;
  if (resolved?.bundleId === bundleId) return resolved.info;
  return { name: fallbackName || bundleId, iconUrl: null };
}

export function useAppIdentity(
  bundleId: string | null | undefined,
  fallbackName?: string | null
): AppIdentityInfo | null {
  const [resolved, setResolved] = useState<ResolvedAppIdentity | null>(null);

  useEffect(() => {
    if (!bundleId) {
      return;
    }
    let request = appInfoCache.get(bundleId);
    if (!request) {
      request = api.appListInfo(bundleId).catch(() => null);
      appInfoCache.set(bundleId, request);
    }
    let alive = true;
    void request.then((result) => {
      if (!alive || !result) return;
      setResolved({ bundleId, info: result });
    });
    return () => {
      alive = false;
    };
  }, [bundleId, fallbackName]);

  return appIdentityForCurrentBundle(bundleId, fallbackName, resolved);
}
