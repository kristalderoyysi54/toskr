package codehl

import (
	"strings"
	"testing"
)

func TestDetect(t *testing.T) {
	cases := map[string]string{
		"package main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}":                       "go",
		"def add(a, b):\n    return a + b\n\nprint(add(1, 2))":                           "python",
		"fn main() {\n    let mut x = 1;\n    println!(\"{}\", x);\n}":                    "rust",
		"const add = (a, b) => {\n  return a + b;\n};":                                    "javascript",
		"interface User {\n  name: string;\n}\nconst u: User = { name: 'a' };":           "typescript",
		"{\n  \"name\": \"toskr\",\n  \"version\": \"0.1.0\"\n}":                         "json",
		"public class Hello {\n  public static void main(String[] args) {\n  }\n}":      "java",
		"SELECT id, name\n  FROM users\n  WHERE id = (\n    SELECT max(id) FROM t\n  ) -> x;":        "sql",
		"#!/bin/bash\nset -e\nif [ -n \"$A\" ]; then\n  echo $A;\nfi":                    "bash",
		"<div class=\"a\">\n  <span>hi</span>\n</div>\n<p>x</p>":                          "",
		"@media (max-width: 600px) {\n  .card {\n    color: red;\n  }\n}":                         "css",
	}
	for src, want := range cases {
		if got := Detect(src); got != want {
			t.Errorf("Detect(%q) = %q，应为 %q", src[:20], got, want)
		}
	}
	// 与 Tauri 同口径：短片段特征不足不算代码
	for _, short := range []string{"SELECT id FROM users;", "#!/bin/bash\necho hi"} {
		if got := Detect(short); got != "" {
			t.Errorf("%q → %q", short, got)
		}
	}
	for _, prose := range []string{"今天下午三点开会，记得带电脑和充电器。", "hello world", "Please review the attached document and reply."} {
		if got := Detect(prose); got != "" {
			t.Errorf("自然语言不应判为代码：%q → %q", prose, got)
		}
	}
}

func TestHighlightRoundTrip(t *testing.T) {
	src := "// note\nconst s = \"x\\\"y\"; let n = 42; /* b */ return n"
	toks := Highlight(src, "javascript")
	var b strings.Builder
	kinds := map[string]Kind{}
	for _, tk := range toks {
		b.WriteString(tk.Text)
		kinds[strings.TrimSpace(tk.Text)] = tk.Kind
	}
	if b.String() != src {
		t.Fatalf("拼回应等于原文：%q", b.String())
	}
	if kinds["// note"] != Comment || kinds["42"] != Number || kinds[`"x\"y"`] != String || kinds["/* b */"] != Comment {
		t.Fatalf("%+v", toks)
	}
	if k := Highlight(`{"a": "b"}`, "json"); k[1].Kind != Keyword || k[3].Kind != String {
		t.Fatalf("JSON 键 / 值 %+v", k)
	}
	if k := Highlight("select * from t", "sql"); k[0].Kind != Keyword {
		t.Fatalf("SQL 小写关键字 %+v", k)
	}
}
