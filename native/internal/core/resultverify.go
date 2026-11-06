package core

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// 回复核验（同 Tauri src/lib/resultVerification.ts verifyResultDeterministically）：只按本地规则呈现证据与问题，
// 不代表结果完全正确。原生版发送记录不留正文，参照正文一律是「当前来源」，基线检查固定为需复核（与 Tauri 无基线时同口径）。

type VerifyStatus string

const (
	VerifyPass   VerifyStatus = "pass"
	VerifyReview VerifyStatus = "needsReview"
	VerifyBlock  VerifyStatus = "blocked"
)

var verifyRank = map[VerifyStatus]int{VerifyPass: 0, VerifyReview: 1, VerifyBlock: 2}

type VerifyCheck struct {
	ID      string
	Status  VerifyStatus
	Message string
}

type VerifyReport struct {
	Status                                 VerifyStatus
	Checks                                 []VerifyCheck
	Missing, Assumptions, Risks, Questions []string
	CreatedAt                              time.Time
}

type VerifyContext struct {
	SourceText     string
	ResultText     string
	Sources        int      // 现存来源条数
	MissingSources []string // 已删除的来源 id
	SourceImages   int
	ResultImages   int
}

type VerifyExpectation struct {
	Format       string         // auto | text | json
	Sections     []string       // 必要标题 / 段落
	JSONFields   []string       // JSON 必填字段（a.b 路径）
	Placeholders map[string]int // 已知发送占位符次数；nil = 会话映射已失效
}

var (
	placeholderRe     = regexp.MustCompile(`\[[A-Z][A-Z0-9_]*_[0-9]{2,}\]`)
	placeholderNameRe = regexp.MustCompile(`^\[[A-Z][A-Z0-9_]*_[0-9]{2,}\]$`)
	truncatedRe       = regexp.MustCompile(`(?:…|\.{3}|未完|待续)$`)
)

// PlaceholderCounts 统计文本里各占位符出现次数。
func PlaceholderCounts(text string) map[string]int {
	m := map[string]int{}
	for _, p := range placeholderRe.FindAllString(text, -1) {
		m[p]++
	}
	return m
}

func uniq(vs []string) []string {
	var out []string
	for _, v := range vs {
		if v = strings.TrimSpace(v); v != "" && !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

func looksTruncated(s string) bool {
	s = strings.TrimSpace(s)
	return truncatedRe.MatchString(s) || strings.Count(s, "```")%2 != 0
}

func jsonPathExists(root any, path string) bool {
	cur := root
	for _, part := range strings.Split(path, ".") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		m, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		if cur, ok = m[part]; !ok {
			return false
		}
	}
	return true
}

func VerifyResult(ctx VerifyContext, exp VerifyExpectation, now time.Time) VerifyReport {
	var r VerifyReport
	add := func(id string, st VerifyStatus, msg string) {
		r.Checks = append(r.Checks, VerifyCheck{id, st, msg})
	}
	result := strings.TrimSpace(ctx.ResultText)
	if result != "" {
		add("result.present", VerifyPass, "结果正文存在")
	} else {
		add("result.present", VerifyBlock, "结果为空")
		r.Missing = append(r.Missing, "结果正文")
	}
	rl := utf8.RuneCountInString(result)
	short := result != "" && (rl < 24 || utf8.RuneCountInString(ctx.SourceText) >= 400 && rl < 80)
	if short {
		add("result.length", VerifyReview, "结果相对过短，可能不完整")
		r.Risks = append(r.Risks, "结果过短，可能遗漏来源内容")
	} else {
		add("result.length", VerifyPass, "结果长度未见明显异常")
	}
	if result != "" && looksTruncated(result) {
		add("result.truncation", VerifyReview, "结果结尾或代码围栏疑似异常截断")
		r.Risks = append(r.Risks, "结果疑似截断")
	} else {
		add("result.truncation", VerifyPass, "未发现常见截断标记")
	}

	expectsJSON := exp.Format == "json" || (exp.Format == "auto" || exp.Format == "") && (strings.HasPrefix(result, "{") || strings.HasPrefix(result, "["))
	var parsed any
	jsonOK := !expectsJSON
	if expectsJSON && result != "" {
		jsonOK = json.Unmarshal([]byte(result), &parsed) == nil
	}
	switch {
	case !expectsJSON:
		add("format.json", VerifyPass, "本次未要求 JSON")
	case jsonOK:
		add("format.json", VerifyPass, "JSON 语法有效")
	default:
		add("format.json", VerifyBlock, "结果不是合法 JSON")
		r.Missing = append(r.Missing, "合法 JSON")
	}
	fields := uniq(exp.JSONFields)
	var missingFields []string
	for _, f := range fields {
		if !(jsonOK && expectsJSON && jsonPathExists(parsed, f)) {
			missingFields = append(missingFields, f)
		}
	}
	switch {
	case len(missingFields) > 0:
		add("format.json-fields", VerifyBlock, "缺少 JSON 必填字段："+strings.Join(missingFields, "、"))
	case len(fields) > 0:
		add("format.json-fields", VerifyPass, "JSON 必填字段齐全")
	default:
		add("format.json-fields", VerifyPass, "未指定 JSON 必填字段")
	}
	for _, f := range missingFields {
		r.Missing = append(r.Missing, "JSON 字段 "+f)
	}

	secs := uniq(exp.Sections)
	low := strings.ToLower(result)
	var missingSecs []string
	for _, s := range secs {
		if !strings.Contains(low, strings.ToLower(s)) {
			missingSecs = append(missingSecs, s)
		}
	}
	switch {
	case len(missingSecs) > 0:
		add("structure.sections", VerifyBlock, "缺少必要标题或段落："+strings.Join(missingSecs, "、"))
	case len(secs) > 0:
		add("structure.sections", VerifyPass, "必要标题或段落齐全")
	default:
		add("structure.sections", VerifyPass, "未指定必要标题或段落")
	}
	for _, s := range missingSecs {
		r.Missing = append(r.Missing, "章节 "+s)
	}

	resPH := PlaceholderCounts(result)
	expected := PlaceholderCounts(ctx.SourceText)
	for p, n := range exp.Placeholders {
		if placeholderNameRe.MatchString(p) {
			expected[p] = max(expected[p], n)
		}
	}
	var missPH, dupPH, unknownPH []string
	for p, n := range expected {
		switch got := resPH[p]; {
		case got < n:
			missPH = append(missPH, p)
		case got > n:
			dupPH = append(dupPH, p)
		}
	}
	for p := range resPH {
		if _, ok := expected[p]; !ok {
			unknownPH = append(unknownPH, p)
		}
	}
	slices.Sort(missPH)
	slices.Sort(dupPH)
	slices.Sort(unknownPH)
	expired := exp.Placeholders == nil
	switch {
	case expired && len(resPH) == 0:
		add("privacy.placeholders", VerifyReview, "应用重启过或该次发送较久，临时占位符清单已清理；无法确认是否有占位符丢失")
	case expired:
		add("privacy.placeholders", VerifyReview, fmt.Sprintf("%d 处临时占位符无法核对（应用重启过或该次发送较久）", len(resPH)))
	case len(missPH)+len(dupPH)+len(unknownPH) > 0:
		add("privacy.placeholders", VerifyReview, "占位符存在丢失、重复或未知项")
	default:
		add("privacy.placeholders", VerifyPass, "占位符数量与已知发送会话一致")
	}
	for _, p := range missPH {
		r.Missing = append(r.Missing, "占位符 "+p)
	}
	if len(dupPH) > 0 {
		r.Risks = append(r.Risks, "占位符重复："+strings.Join(dupPH, "、"))
	}
	if expired {
		r.Risks = append(r.Risks, "应用重启过或该次发送较久，临时占位符清单已清理，数量核对不可用；如需严格核对请人工比对")
		if len(resPH) > 0 {
			keys := make([]string, 0, len(resPH))
			for p := range resPH {
				keys = append(keys, p)
			}
			slices.Sort(keys)
			r.Risks = append(r.Risks, "临时占位符 "+strings.Join(keys, "、")+" 无法判断是否来自本次发送")
		}
	} else {
		for _, p := range unknownPH {
			r.Assumptions = append(r.Assumptions, "未知占位符 "+p)
		}
	}

	add("source.execution-baseline", VerifyReview, "原投递正文基线不可用；当前来源仅供参考，不能证明与历史投递一致")
	r.Risks = append(r.Risks, "未保留原投递正文或会话已过期，不能完成历史投递一致性核验")
	if len(ctx.MissingSources) > 0 || ctx.Sources == 0 {
		add("source.references", VerifyBlock, fmt.Sprintf("来源引用缺失 %d 项", max(len(ctx.MissingSources), 1)))
		for _, id := range ctx.MissingSources {
			r.Missing = append(r.Missing, "来源 "+id)
		}
		if ctx.Sources == 0 && len(ctx.MissingSources) == 0 {
			r.Missing = append(r.Missing, "来源关联")
		}
	} else {
		add("source.references", VerifyPass, fmt.Sprintf("当前来源 %d 项均存在", ctx.Sources))
	}
	if ctx.Sources > 0 && strings.TrimSpace(ctx.SourceText) == "" {
		add("source.content", VerifyBlock, "参照正文没有可核验文本")
		r.Missing = append(r.Missing, "来源文本")
	} else {
		add("source.content", VerifyPass, "参照正文包含可核验文本")
	}
	if ctx.SourceImages+ctx.ResultImages > 0 {
		add("scope.images", VerifyReview, fmt.Sprintf("图片附件不在本阶段文本核验范围（来源 %d，结果 %d）", ctx.SourceImages, ctx.ResultImages))
		r.Risks = append(r.Risks, "图片附件内容需人工核对")
	} else {
		add("scope.images", VerifyPass, "本次没有超出文本核验范围的图片附件")
	}
	if len(r.Missing) > 0 {
		r.Questions = append(r.Questions, "是否补齐所有明确缺失项后重新核验？")
	}
	r.Status = VerifyPass
	for _, c := range r.Checks {
		if verifyRank[c.Status] > verifyRank[r.Status] {
			r.Status = c.Status
		}
	}
	r.Missing, r.Assumptions, r.Risks, r.Questions = uniq(r.Missing), uniq(r.Assumptions), uniq(r.Risks), uniq(r.Questions)
	r.CreatedAt = now
	return r
}

var reportStatusLabel = map[VerifyStatus]string{VerifyPass: "规则内未发现问题", VerifyReview: "需要人工复核", VerifyBlock: "存在明确缺失或阻断"}

// StatusLabel：报告状态的中文名。
func (s VerifyStatus) Label() string { return reportStatusLabel[s] }

func reportLines(title string, vs []string) []string {
	if len(vs) == 0 {
		return nil
	}
	out := []string{"## " + title}
	for _, v := range vs {
		out = append(out, "- "+v)
	}
	return append(out, "")
}

// FormatVerifyReport 同 Tauri formatVerificationReport（保存为笔记的正文）。
func FormatVerifyReport(r VerifyReport) string {
	lines := []string{"# 结果核验报告", "", "状态：" + r.Status.Label(), "生成时间：" + r.CreatedAt.Format("2006/1/2 15:04:05"),
		"说明：核验只呈现规则内证据与问题，不代表结果完全正确，也不替代人工审批。", "", "## 检查"}
	for _, c := range r.Checks {
		lines = append(lines, fmt.Sprintf("- [%s] %s", c.Status, c.Message))
	}
	lines = append(lines, "")
	lines = append(lines, reportLines("明确缺失", r.Missing)...)
	lines = append(lines, reportLines("新增假设", r.Assumptions)...)
	lines = append(lines, reportLines("风险", r.Risks)...)
	lines = append(lines, reportLines("待确认问题", r.Questions)...)
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// VerifyQuestionsText 同 Tauri verificationQuestionsText（问题清单，可继续发给对方）。空 = 没有可问的。
func VerifyQuestionsText(r VerifyReport) string {
	var items []string
	items = append(items, r.Questions...)
	for _, m := range r.Missing {
		items = append(items, "请补齐："+m)
	}
	for _, m := range r.Risks {
		items = append(items, "请核对风险："+m)
	}
	items = uniq(items)
	if len(items) == 0 {
		return ""
	}
	lines := []string{"# 结果核验待确认问题", "", "请基于下列问题给出证据充分、逐项对应的答复；不知道时明确说明，不要猜测：", ""}
	for i, it := range items {
		lines = append(lines, fmt.Sprintf("%d. %s", i+1, it))
	}
	return strings.Join(lines, "\n")
}
