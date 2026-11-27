package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// schemaFields：数据文件里所有会落盘的字段（类型.json 名），递归走遍 snapshot。
func schemaFields() []string {
	seen := map[reflect.Type]bool{}
	var out []string
	var walk func(t reflect.Type)
	walk = func(t reflect.Type) {
		for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice || t.Kind() == reflect.Array || t.Kind() == reflect.Map {
			t = t.Elem()
		}
		if t.Kind() != reflect.Struct || seen[t] || t.PkgPath() != reflect.TypeFor[snapshot]().PkgPath() {
			return
		}
		seen[t] = true
		for i := range t.NumField() {
			f := t.Field(i)
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "-" || !f.IsExported() {
				continue
			}
			if name == "" {
				name = f.Name
			}
			out = append(out, t.Name()+"."+name)
			walk(f.Type)
		}
	}
	walk(reflect.TypeFor[snapshot]())
	sort.Strings(out)
	return out
}

// 字段指纹：持久化结构体增删字段时这里会失败——把 SchemaVersion +1，再把下面的指纹换成报出来的新值。
// 不改版本号的后果：旧版本应用读到带新字段的数据不会进只读，一保存就把新字段抹掉。
func TestSchemaFingerprint(t *testing.T) {
	const version, want = 3, "dd1651ba79a9a0ea"
	sum := sha256.Sum256([]byte(strings.Join(schemaFields(), "\n")))
	got := hex.EncodeToString(sum[:8])
	if SchemaVersion != version || got != want {
		t.Fatalf("持久化字段变了：SchemaVersion（现为 %d）要 +1，并把本测试的 version / want 改成 %d / %q", SchemaVersion, SchemaVersion, got)
	}
}

// 读到比自己新的数据：能看、不能改、不落盘（文件逐字节不变）；同版本照常可写。
func TestNewerSchemaIsReadOnly(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	dir := t.TempDir()
	s, _ := OpenDir(dir, key)
	n, _, _ := s.Add(Note{Section: SectionInbox, Text: "原有的"})
	_ = s.Flush()
	if s.Newer() {
		t.Fatal("同版本不该只读")
	}
	path := filepath.Join(dir, DataFile)
	raw, _ := os.ReadFile(path)
	plain, _ := Open(key, PurposeData, raw)
	var doc map[string]any
	_ = json.Unmarshal(plain, &doc)
	doc["version"], doc["fromTheFuture"] = SchemaVersion+1, "新字段"
	plain, _ = json.Marshal(doc)
	sealed, _ := Seal(key, PurposeData, plain)
	_ = os.WriteFile(path, sealed, 0o600)

	var hit error
	s2, err := OpenDir(dir, key)
	if err != nil || !s2.Newer() {
		t.Fatalf("应能打开并标记只读 %v", err)
	}
	s2.OnError = func(e error) { hit = e }
	if _, ok := s2.Note(n.ID); !ok {
		t.Fatal("内容应能照常读")
	}
	if _, _, err := s2.Add(Note{Section: SectionInbox, Text: "写不进"}); !errors.Is(err, ErrNewer) || !errors.Is(hit, ErrNewer) {
		t.Fatalf("新增应被拒 %v", err)
	}
	if err := s2.SetDone(n.ID, true); !errors.Is(err, ErrNewer) {
		t.Fatalf("修改应被拒 %v", err)
	}
	_ = s2.Flush()
	if now, _ := os.ReadFile(path); !bytes.Equal(now, sealed) {
		t.Fatal("只读期间文件不该被改写")
	}
}
