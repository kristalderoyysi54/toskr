package store

import (
	"slices"
	"testing"
)

func TestPageOrder(t *testing.T) {
	if got := NormalizePageOrder([]string{"tasks", "bogus", "tasks", "clipboard"}); !slices.Equal(got, []string{"tasks", "clipboard", "notes", "secret"}) {
		t.Fatal(got)
	}
	if got := MovePage(nil, "tasks", "clipboard"); !slices.Equal(got, []string{"tasks", "clipboard", "notes", "secret"}) {
		t.Fatal(got)
	}
	if got := MovePage(nil, "clipboard", "tasks"); !slices.Equal(got, []string{"notes", "tasks", "clipboard", "secret"}) {
		t.Fatal(got)
	}
	if got := applyTauriSettings(Settings{}, tauriSettings{PageOrder: []string{"notes", "clipboard"}}).PageOrder; !slices.Equal(got, []string{"notes", "clipboard", "tasks", "secret"}) {
		t.Fatalf("Tauri 导入应带上页签顺序 %v", got)
	}
}
