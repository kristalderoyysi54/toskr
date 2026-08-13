import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUIState, mockUseUIStore } = vi.hoisted(() => {
  const state = {
    doneOpen: {} as Record<string, boolean>,
    focusedId: null as string | null,
    flashId: null as string | null,
    editingId: null as string | null,
    toggleDoneOpen(key: string) {
      state.doneOpen = { ...state.doneOpen, [key]: !state.doneOpen[key] };
    },
  };
  const store = Object.assign(
    <T,>(selector: (value: typeof state) => T) => selector(state),
    { getState: () => state }
  );
  return { mockUIState: state, mockUseUIStore: store };
});

vi.mock("@/store/uiStore", () => ({ useUIStore: mockUseUIStore }));

import {
  TaskPage,
  TASK_OVERDUE_COLLAPSED_KEY,
} from "@/components/TaskPage";
import type { TaskBuckets } from "@/lib/tasks";
import { TASK_INBOX_ID } from "@/store/notesStore";

const NOW = new Date(2026, 7, 13, 12, 0).getTime();

const buckets: TaskBuckets = {
  overdue: [
    {
      id: "overdue-1",
      text: "处理逾期任务",
      status: "todo",
      priority: "none",
      dueAt: NOW - 60_000,
      createdAt: NOW - 120_000,
      remindedAt: null,
      sectionId: TASK_INBOX_ID,
    },
  ],
  sparks: [
    {
      id: "spark-1",
      text: "保留灵感",
      status: "todo",
      priority: "none",
      dueAt: null,
      createdAt: NOW - 30_000,
      remindedAt: null,
      kind: "spark",
      sectionId: TASK_INBOX_ID,
    },
  ],
  groups: [
    {
      section: { id: TASK_INBOX_ID, name: "收集箱" },
      tasks: [],
    },
  ],
  done: [],
};

function overdueHeading(html: string): string {
  const match = html.match(
    /<button[^>]*aria-label="(?:展开|折叠)已到期分组"[^>]*>[\s\S]*?<\/button>/
  );
  expect(match).not.toBeNull();
  return match![0];
}

describe("TaskPage 已到期智能区", () => {
  beforeEach(() => {
    mockUIState.doneOpen = {};
  });

  it("提供与灵感区一致的折叠箭头，并按状态隐藏任务", () => {
    const expanded = renderToStaticMarkup(<TaskPage buckets={buckets} now={NOW} />);
    const expandedHeading = overdueHeading(expanded);

    expect(expandedHeading).toContain('title="折叠"');
    expect(expandedHeading).toContain('aria-label="折叠已到期分组"');
    expect(expandedHeading).toContain('aria-expanded="true"');
    expect(expandedHeading).toContain("lucide-chevron-down");
    expect(expanded).toContain("处理逾期任务");

    mockUIState.toggleDoneOpen(TASK_OVERDUE_COLLAPSED_KEY);
    const collapsed = renderToStaticMarkup(<TaskPage buckets={buckets} now={NOW} />);
    const collapsedHeading = overdueHeading(collapsed);

    expect(collapsedHeading).toContain('title="展开"');
    expect(collapsedHeading).toContain('aria-label="展开已到期分组"');
    expect(collapsedHeading).toContain('aria-expanded="false"');
    expect(collapsedHeading).toContain("lucide-chevron-right");
    expect(collapsed).not.toContain("处理逾期任务");
    expect(collapsed).toContain("保留灵感");
  });
});
