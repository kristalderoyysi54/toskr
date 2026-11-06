package core

import (
	"testing"

	"github.com/toskr/native/internal/store"
)

func TestAliases(t *testing.T) {
	dict := []store.AliasEntity{
		{ID: "1", Category: "USER", OriginalText: "张三", Placeholder: "[USER_01]"},
		{ID: "2", Category: "USER", OriginalText: "张三丰", Placeholder: "[USER_02]"},
		{ID: "3", Category: "MERCHANT", OriginalText: "商户 12345", Placeholder: "[MERCHANT_01]"},
	}
	out, n := ApplyAliases("张三丰和张三在商户 12345 见面，[USER_01] 不再替换", dict)
	if out != "[USER_02]和[USER_01]在[MERCHANT_01] 见面，[USER_01] 不再替换" || n != 3 {
		t.Fatalf("%q %d", out, n)
	}
	back, m := RestoreAliases("回复：[USER_02] 已联系 [USER_01]，[EMAIL_01] 保持", dict)
	if back != "回复：张三丰 已联系 张三，[EMAIL_01] 保持" || m != 2 {
		t.Fatalf("%q %d", back, m)
	}
	if AliasOccurrences("[USER_01] [X_01] [USER_02]", dict) != 2 {
		t.Fatal("可还原处数")
	}
	p, next := AllocateAliasPlaceholder("ORDER", map[string]int{"ORDER": 7})
	if p != "[ORDER_07]" || next["ORDER"] != 8 {
		t.Fatal(p, next)
	}
	if SuggestAliasCategory("a@b.com") != "CONTACT" || SuggestAliasCategory("SO-2024-001") != "ORDER" || SuggestAliasCategory("王五") != "USER" {
		t.Fatal("类别推断")
	}
	if AliasOriginalIssue(" 张三", dict, "") == "" || AliasOriginalIssue("张三", dict, "") == "" || AliasOriginalIssue("张三", dict, "1") != "" || AliasOriginalIssue("[USER_09]", dict, "") == "" {
		t.Fatal("原文校验")
	}
	if ValidAliasCategoryCode("EMAIL") || !ValidAliasCategoryCode("VENDOR") || ValidAliasCategoryCode("vendor") {
		t.Fatal("类别码校验")
	}
}
