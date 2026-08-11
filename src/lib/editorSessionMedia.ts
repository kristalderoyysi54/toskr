export const NOTE_EDITOR_SESSION_RELEASE_EVENT =
  "toskr://note-editor-session-release";

export type NoteEditorSessionReleasePayload = {
  targetSessionId: string;
  dataGeneration: number;
};

type SessionMedia = {
  dataGeneration: number;
  operations: Map<string, Set<string>>;
};

type MediaRelease = { files: string[]; dataGeneration: number };

const sessions = new Map<string, SessionMedia>();
const releaseListeners = new Set<(release: MediaRelease) => void>();

function notifyRelease(release: MediaRelease) {
  if (!release.files.length) return;
  for (const listener of releaseListeners) listener(release);
}

/** 在主 WebView 暂存未保存编辑草稿的媒体引用，避免来源卡删除后被 GC。 */
export function retainEditorOperationMedia(
  sessionId: string,
  operationKey: string,
  dataGeneration: number,
  files: string[]
) {
  const unique = new Set(files.filter(Boolean));
  if (!unique.size) return;
  const session = sessions.get(sessionId) ?? {
    dataGeneration,
    operations: new Map<string, Set<string>>(),
  };
  session.operations.set(operationKey, unique);
  sessions.set(sessionId, session);
}

export function releaseEditorOperationMedia(
  sessionId: string,
  operationKey: string
) {
  const session = sessions.get(sessionId);
  const files = [...(session?.operations.get(operationKey) ?? [])];
  if (!session) return files;
  session.operations.delete(operationKey);
  if (!session.operations.size) sessions.delete(sessionId);
  notifyRelease({ files, dataGeneration: session.dataGeneration });
  return files;
}

export function releaseEditorSessionMedia(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  const files = [...new Set([...session.operations.values()].flatMap((set) => [...set]))];
  sessions.delete(sessionId);
  notifyRelease({ files, dataGeneration: session.dataGeneration });
  return files;
}

export function editorSessionMediaFiles() {
  return [
    ...new Set(
      [...sessions.values()].flatMap((session) =>
        [...session.operations.values()].flatMap((files) => [...files])
      )
    ),
  ];
}

export function subscribeEditorMediaReleases(
  listener: (release: MediaRelease) => void
) {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

/** 数据目录切换时旧路径整体失效，不得把释放任务投到新目录。 */
export function clearEditorSessionMedia() {
  sessions.clear();
}
