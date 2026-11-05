package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/diag"
)

var langPackHinted atomic.Bool

// 本机中英互译（同 Tauri screenshot.rs translate_local）：经包内 Swift 辅助程序调系统翻译框架（macOS 15+，离线语言包），
// 比 AI 快一个量级且不联网。辅助程序缺失、系统低于 15、语言包未装或超时都返回错误，由调用方退回 AI。
// 辅助程序源码在 src-tauri/translate-helper/main.swift，由 script/translate-helper.sh 构建后拷进 resources/darwin。

const translateHelperName = "toskr-translate-helper"

var errTranslateHelperMissing = errors.New("translate helper missing")

// localTranslateReason：本机翻译用不了的原因（同 Rust LocalTranslate::from_error）。
type localTranslateReason int

const (
	localUnknown localTranslateReason = iota
	localDownload
	localUnsupported
)

func translateReason(err error) localTranslateReason {
	switch err.Error() {
	case "language pack not installed":
		return localDownload
	case "language pair unsupported", "macOS 15 required":
		return localUnsupported
	}
	return localUnknown
}

// translateLocal 可替换（测试）。
var translateLocal = func(lines []string) ([]string, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	helper := filepath.Join(filepath.Dir(exe), "..", "Resources", translateHelperName)
	if _, err := os.Stat(helper); err != nil {
		return nil, errTranslateHelperMissing
	}
	return runTranslateHelper(helper, lines)
}

func runTranslateHelper(helper string, lines []string) ([]string, error) {
	target := "zh-Hans"
	if langEN.Load() {
		target = "en"
	}
	in, _ := json.Marshal(map[string]any{"target": target, "lines": lines})
	// 辅助程序自身 8 秒超时，这里多留余量；系统翻译服务偶尔不应答，不能让图内翻译一直挂着
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, helper)
	cmd.Stdin = bytes.NewReader(in)
	out, runErr := cmd.Output()
	if ctx.Err() != nil {
		return nil, errors.New("helper timeout")
	}
	var reply struct {
		Lines []string `json:"lines"`
		Error string   `json:"error"`
	}
	if err := json.Unmarshal(out, &reply); err != nil {
		if runErr != nil {
			return nil, runErr // 低于 macOS 15 时 dyld 直接拒绝加载，走这里
		}
		return nil, err
	}
	if reply.Error != "" {
		return nil, errors.New(reply.Error)
	}
	if len(reply.Lines) != len(lines) {
		return nil, errors.New("bad reply")
	}
	return reply.Lines, nil
}

// translateTexts：先本机，用不了再退回 AI（同 Tauri screenshot_translate + App.tsx 代办）。
// 返回译文，或遮罩上短提示 errMsg；hint 为遮罩关掉后弹的引导（缺离线语言包）。
func translateTexts(cfg ai.Config, texts []string) (out []string, errMsg, hint string) {
	started := time.Now()
	out, err := translateLocal(texts)
	if err == nil {
		diag.Push("图内翻译走本机 %d 行 %dms", len(texts), time.Since(started).Milliseconds())
		return out, "", ""
	}
	diag.Push("本机翻译不可用（%v），改用 AI", err)
	needsPack := translateReason(err) == localDownload
	out, err = translateLines(cfg, texts)
	switch {
	case err == nil:
		// AI 顶上了：只提醒一次可改走本机（Tauri 记在 localStorage，原生按进程记）
		if needsPack && langPackHinted.CompareAndSwap(false, true) {
			hint = tr("图内翻译这次用了 AI；下载系统离线语言包后更快且不联网：系统设置 → 通用 → 语言与地区 → 翻译语言")
		}
		return out, "", hint
	case needsPack && errors.Is(err, ai.ErrNoKey):
		return nil, tr("未安装离线翻译语言包，关闭截图后按提示下载"), tr("图内翻译需要系统离线语言包：系统设置 → 通用 → 语言与地区 → 翻译语言")
	case errors.Is(err, ai.ErrNoKey):
		return nil, err.Error(), ""
	}
	diag.Push("图内翻译失败：%v", err)
	return nil, tr("翻译失败"), ""
}
