package core

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// 同 Tauri parseRichClipboard：图文按顺序成块，表格单元 Tab / 行换行，脚本与样式不进正文，不支持的图片计数。
func TestParseRichHTML(t *testing.T) {
	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte{1, 2, 3})
	h := `<style>.x{}</style><p>前 &amp; 言</p><img src="` + data + `" alt=" 图 一 "><div>后记</div>` +
		`<img src="javascript:alert(1)"><img src="/rel.png"><img src="a.svg">` +
		`<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>` +
		`<img src="` + data + `"><script>bad()</script>`
	r := ParseRichHTML("纯文本", h, "")
	if len(r.Sources) != 1 || r.Omitted != 3 || !slices.Equal(r.OmittedSchemes, []string{"javascript", "relative", "relative"}) {
		t.Fatalf("sources=%v omitted=%d %v", r.Sources, r.Omitted, r.OmittedSchemes)
	}
	want := []RichBlock{{Text: "前 & 言"}, {Image: true, Alt: "图 一"}, {Text: "后记\na\tb\nc\td"}, {Image: true}}
	if len(r.Blocks) != len(want) {
		t.Fatalf("%+v", r.Blocks)
	}
	for i, b := range want {
		if r.Blocks[i] != b {
			t.Fatalf("块 %d = %+v，期望 %+v", i, r.Blocks[i], b)
		}
	}
	// 有来源网页时相对路径按它解析
	if r := ParseRichHTML("", `<img src="/a.png">`, "https://ex.test/page"); len(r.Sources) != 1 || r.Sources[0] != "https://ex.test/a.png" {
		t.Fatalf("%v", r.Sources)
	}
	// 没有图片：整段用纯文本
	if r := ParseRichHTML("纯文本", "<b>粗体</b>", ""); len(r.Blocks) != 1 || r.Blocks[0].Text != "纯文本" {
		t.Fatalf("%+v", r.Blocks)
	}
}

func TestLocalizeRichGates(t *testing.T) {
	pngBytes := tinyPNG(t)
	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(pngBytes) }))
	defer srv.Close()
	inLib := filepath.Join(os.TempDir(), "toskr-rich-test.png") // 临时目录在放行根内
	_ = os.WriteFile(inLib, pngBytes, 0o600)
	defer os.Remove(inLib)
	h := `<p>甲</p><img src="` + data + `"><img src="` + srv.URL + `/x.png"><img src="file://` + inLib + `">`
	saved := 0
	save := func([]byte) (string, error) { saved++; return "f" + string(rune('0'+saved)) + ".png", nil }

	r := ParseRichHTML("", h, "")
	blocks, failed := LocalizeRich(r, "", save)
	if failed != 1 { // 回环地址的 http 图被 SSRF 闸门拒绝
		t.Fatalf("应只有内网下载失败 failed=%d", failed)
	}
	if len(blocks) != 3 || blocks[1].Type != "image" || blocks[1].Width != 3 || blocks[1].Height != 2 || blocks[2].Type != "image" {
		t.Fatalf("%+v", blocks)
	}
	// 来自网页的复制：file:// 一律拒绝
	_, failed = LocalizeRich(ParseRichHTML("", `<img src="file://`+inLib+`">`, "https://ex.test/"), "https://ex.test/", save)
	if failed != 1 {
		t.Fatal("网页来源不应读本地文件")
	}
	// 文稿树不在放行根内
	if localImageAllowed("/Users/x/Documents/a.png") || !localImageAllowed("/private/tmp/a.png") {
		t.Fatal("本地图片根白名单")
	}
}
