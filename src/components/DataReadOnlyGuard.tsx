import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { DATA_ACTIVITY_EVENT } from "@/lib/dataOperations";

type RemoteDataActivity = {
  locked: boolean;
  message: string;
};

function useRemoteDataActivity(): RemoteDataActivity {
  const [activity, setActivity] = useState<RemoteDataActivity>({
    locked: false,
    message: "",
  });
  useEffect(() => {
    const unlisten = listen<RemoteDataActivity>(DATA_ACTIVITY_EVENT, (event) =>
      setActivity(event.payload)
    );
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);
  return activity;
}

export function DataReadOnlyGuard() {
  const activity = useRemoteDataActivity();
  if (!activity.locked) return null;
  return (
    <div
      role="status"
      aria-live="assertive"
      aria-busy="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 px-6 text-foreground backdrop-blur-sm"
    >
      <div className="rounded-xl border border-border bg-popover px-4 py-3 text-center shadow-lg">
        <p className="text-title font-medium">数据暂时只读</p>
        <p className="mt-1 text-body text-muted-foreground">
          {activity.message || "正在验证并切换数据目录…"}
        </p>
      </div>
    </div>
  );
}
