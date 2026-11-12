package main

import (
	"fmt"
	"slices"
)

// 进阶上手课（合并发送 / 智能脱敏与还原）的纯状态机，同 Tauri src/lib/lessons.ts。
// 进度只在内存里：课程随时可重来；示例卡片带固定来源标记，任何时候都能按标记清理。

const (
	lessonMerge   = "merge"
	lessonPrivacy = "privacy"
	// 示例卡片的来源标记：清理只认这个 bundle，绝不按正文匹配用户内容。
	lessonSampleBundle = "com.toskr.tutorial"
	lessonSampleApp    = "Toskr 教程"
	privacyLessonAlias = "张三"
	// 示例里的邮箱与基础课同一个（RFC 2606 保留域名）
	privacyLessonSample = "请把会议纪要发给张三，抄送 demo.user@example.com。"
)

var mergeLessonSamples = []string{
	"报错：点击保存后控制台出现 TypeError: cannot read 'id'",
	"复现：修改标题 → 点保存 → 刷新页面，改动消失",
}

var lessonSteps = map[string][3]string{
	lessonMerge:   {"放入示例卡片", "勾选两张", "一起发送"},
	lessonPrivacy: {"准备示例", "发送并替换", "收回并还原"},
}

// privacyLessonReply：模拟 AI 回复，带占位符，收进 Toskr 时由本机词典还原。
func privacyLessonReply(placeholder string) string {
	return fmt.Sprintf(tr("好的，已把会议纪要发给 %s。"), placeholder)
}

type lessonProgress struct {
	id        string
	step      int // 0 准备示例 → 1 → 2 → 3 完成
	sampleIDs []string
	aliasID   string
	replyID   string // 还原课收回的回复卡，完成时一并清理
}

func startLesson(id string) lessonProgress { return lessonProgress{id: id} }

func lessonSamplesReady(p lessonProgress, ids []string, aliasID string) (lessonProgress, bool) {
	if p.step != 0 {
		return p, false
	}
	p.step, p.sampleIDs, p.aliasID = 1, ids, aliasID
	return p, true
}

// lessonAfterChecked：合并课第 2 步，两张示例卡都被勾选即前进；取消勾选不回退。
func lessonAfterChecked(p lessonProgress, checked func(string) bool) (lessonProgress, bool) {
	if p.id != lessonMerge || p.step != 1 || len(p.sampleIDs) < 2 {
		return p, false
	}
	for _, id := range p.sampleIDs {
		if !checked(id) {
			return p, false
		}
	}
	p.step = 2
	return p, true
}

// lessonAfterDelivery：合并课要求一次发送包含全部示例卡（≥2 张）；还原课要求发送了示例卡。
func lessonAfterDelivery(p lessonProgress, sourceIDs []string) (lessonProgress, bool) {
	all := len(p.sampleIDs) > 0
	for _, id := range p.sampleIDs {
		all = all && slices.Contains(sourceIDs, id)
	}
	switch {
	case p.id == lessonMerge && p.step >= 1 && p.step < 3 && all && len(sourceIDs) >= 2:
		p.step = 3
	case p.id == lessonPrivacy && p.step == 1 && all:
		p.step = 2
	default:
		return p, false
	}
	return p, true
}

// lessonAfterCapture：还原课第 3 步，捕获时至少还原了一处化名即完成。
func lessonAfterCapture(p lessonProgress, noteID string, restored int) (lessonProgress, bool) {
	if p.id != lessonPrivacy || p.step != 2 || noteID == "" || restored < 1 {
		return p, false
	}
	p.step, p.replyID = 3, noteID
	return p, true
}
