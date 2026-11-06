package main

import (
	"context"
	hexenc "encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/store"
)

// 从 Tauri 版导入：Tauri 的数据密钥在登录钥匙串 com.toskr.app.data / data-encryption-key-v1（32 字节原值），
// 其 ACL 只信任 Tauri 自己的密钥辅助程序。这里经系统 security 工具读取：系统会弹一次授权框，
// 用户允许后密钥只在本进程内存里用于解密，不落盘、不进日志。

// tauriKey 可替换（测试）。
var tauriKey = func() ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute) // 等用户在授权框里处理
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password",
		"-s", "com.toskr.app.data", "-a", "data-encryption-key-v1", "-w").Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 44 {
			return nil, errors.New(tr("钥匙串里没有 Tauri 版的数据密钥"))
		}
		return nil, errors.New(tr("没有取得钥匙串授权"))
	}
	return parseKeychainKey(out)
}

// parseKeychainKey：security -w 对不可打印的二进制值输出十六进制；可打印时原样输出。
func parseKeychainKey(out []byte) ([]byte, error) {
	s := strings.TrimRight(string(out), "\r\n")
	if len(s) == 64 {
		if b, err := hexenc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	if len(s) == 32 {
		return []byte(s), nil
	}
	return nil, errors.New(tr("Tauri 数据密钥格式无法识别"))
}

// importTauri：后台取密钥、导入，回主线程刷新并给出结果气泡。
func (a *app) importTauri(done func(string, error)) {
	if a.tauriImporting {
		return
	}
	a.tauriImporting = true
	dir := store.TauriDataDir()
	go func() {
		var msg string
		key, err := tauriKey()
		if err == nil {
			var rep store.TauriReport
			rep, err = a.store.ImportTauri(dir, key)
			clear(key)
			if err == nil {
				diag.Push("Tauri 导入 %s：笔记 %d 分组 %d 任务 %d 账单 %d 秘文 %d 图片 %d（缺 %d）清除合成 %d 恢复点 %s",
					dir, rep.Notes, rep.Sections, rep.Tasks, rep.Bills, rep.Secrets, rep.Media, rep.MediaMissing, rep.SeedRemoved, rep.Recovery)
				msg = fmt.Sprintf(tr("已从 Tauri 版导入：笔记 %d、分组 %d、任务 %d、账单 %d、秘文 %d、发送记录 %d"), rep.Notes, rep.Sections, rep.Tasks, rep.Bills, rep.Secrets, rep.Deliveries)
				if rep.MediaMissing > 0 {
					msg += fmt.Sprintf(tr("；%d 张图片缺失"), rep.MediaMissing)
				}
			}
		}
		if err != nil {
			diag.Push("Tauri 导入失败：%v", err)
		}
		a.onMain(func() {
			a.tauriImporting = false
			if err != nil {
				a.showHUD("warn", fmt.Sprintf(tr("导入失败：%v"), err))
			} else {
				a.reload()
				a.showHUD("ok", msg)
			}
			if done != nil {
				done(msg, err)
			}
		})
	}()
}

// onMain：回主线程执行（无面板窗口时直接执行，测试用）。
func (a *app) onMain(fn func()) {
	if a.panel != nil {
		a.panel.Update(fn)
	} else {
		fn()
	}
}
