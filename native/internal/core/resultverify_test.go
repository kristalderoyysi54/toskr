package core

import (
	"strings"
	"testing"
	"time"
)

func statusOf(r VerifyReport, id string) VerifyStatus {
	for _, c := range r.Checks {
		if c.ID == id {
			return c.Status
		}
	}
	return ""
}

func TestVerifyResult(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	ctx := VerifyContext{SourceText: "请把联系人 [EMAIL_01] 的资料整理成 JSON", ResultText: `{"name":"a","contact":{"email":"[EMAIL_01]"}}`, Sources: 1}
	r := VerifyResult(ctx, VerifyExpectation{Format: "auto", JSONFields: []string{"name", "contact.email", "phone"}, Placeholders: map[string]int{"[EMAIL_01]": 1}}, now)
	if statusOf(r, "format.json") != VerifyPass || statusOf(r, "format.json-fields") != VerifyBlock || r.Status != VerifyBlock {
		t.Fatalf("%+v", r.Checks)
	}
	if !strings.Contains(strings.Join(r.Missing, "|"), "JSON 字段 phone") || statusOf(r, "privacy.placeholders") != VerifyPass {
		t.Fatalf("%v %+v", r.Missing, r.Checks)
	}
	// 截断、缺章节、占位符丢失与未知、映射失效
	r = VerifyResult(VerifyContext{SourceText: "x", ResultText: "## 结论\n内容写到一半…", Sources: 1}, VerifyExpectation{Format: "text", Sections: []string{"结论", "风险"}, Placeholders: map[string]int{"[PHONE_01]": 1}}, now)
	if statusOf(r, "result.truncation") != VerifyReview || statusOf(r, "structure.sections") != VerifyBlock || statusOf(r, "privacy.placeholders") != VerifyReview {
		t.Fatalf("%+v", r.Checks)
	}
	if r.Questions[0] != "是否补齐所有明确缺失项后重新核验？" {
		t.Fatal(r.Questions)
	}
	r = VerifyResult(VerifyContext{ResultText: "回复里有 [EMAIL_02]，长度也足够长足够长足够长足够长"}, VerifyExpectation{}, now)
	if statusOf(r, "source.references") != VerifyBlock || !strings.Contains(strings.Join(r.Risks, "|"), "[EMAIL_02]") {
		t.Fatalf("%+v %v", r.Checks, r.Risks)
	}
	if !strings.HasPrefix(FormatVerifyReport(r), "# 结果核验报告") || !strings.Contains(VerifyQuestionsText(r), "1. ") {
		t.Fatal("报告格式")
	}
}
