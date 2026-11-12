package main

import "strings"

// 文本对比（发送前对比窗用）：Myers 差分。默认按字符比；改动太多（编辑距离超过上限）时退回按行比，避免长文卡顿。

type diffKind int

const (
	diffEq diffKind = iota
	diffDel
	diffIns
)

type diffSeg struct {
	kind diffKind
	text string
}

const diffMaxD = 1500

// textDiff：from → to 的差分片段（相邻同类合并）。
func textDiff(from, to string) []diffSeg {
	a, b := splitRunes(from), splitRunes(to)
	segs, ok := myers(a, b, diffMaxD)
	if !ok {
		segs, _ = myers(splitLines(from), splitLines(to), -1)
	}
	return cleanupDiff(segs)
}

// cleanupDiff：夹在两段改动之间、不超过 2 个字的相同片段并入改动（「13800138000 → [PHONE_1]」碰巧共有的「1」
// 不该把一处替换切成三截）；每段改动整理成「先删后增」。
func cleanupDiff(segs []diffSeg) []diffSeg {
	var out []diffSeg
	var del, ins strings.Builder
	inRun := false
	flush := func() {
		if del.Len() > 0 {
			out = append(out, diffSeg{diffDel, del.String()})
		}
		if ins.Len() > 0 {
			out = append(out, diffSeg{diffIns, ins.String()})
		}
		del.Reset()
		ins.Reset()
		inRun = false
	}
	for i, s := range segs {
		switch {
		case s.kind == diffDel:
			del.WriteString(s.text)
			inRun = true
		case s.kind == diffIns:
			ins.WriteString(s.text)
			inRun = true
		case inRun && i+1 < len(segs) && len([]rune(s.text)) <= 2: // 两侧都是改动的短相同片段
			del.WriteString(s.text)
			ins.WriteString(s.text)
		default:
			flush()
			out = append(out, s)
		}
	}
	flush()
	return out
}

func splitRunes(s string) []string {
	out := make([]string, 0, len(s))
	for _, r := range s {
		out = append(out, string(r))
	}
	return out
}

func splitLines(s string) []string { return strings.SplitAfter(s, "\n") }

// myers：经典 O((N+M)D) 差分；maxD > 0 且编辑距离超过它时返回 ok=false。
func myers(a, b []string, maxD int) ([]diffSeg, bool) {
	ops, ok := myersOps(a, b, maxD)
	if !ok {
		return nil, false
	}
	var out []diffSeg
	for _, s := range ops {
		if l := len(out); l > 0 && out[l-1].kind == s.kind {
			out[l-1].text += s.text
			continue
		}
		out = append(out, s)
	}
	return out, true
}

// myersOps：逐单元（字 / 行）的编辑序列，不合并（按行对齐用）。
func myersOps(a, b []string, maxD int) ([]diffSeg, bool) {
	n, m := len(a), len(b)
	max := n + m
	if maxD > 0 && maxD < max {
		max = maxD
	}
	off := max + 1
	v := make([]int, 2*max+3)
	var trace [][]int
	found := n == 0 && m == 0
	for d := 0; d <= max && !found; d++ {
		trace = append(trace, append([]int(nil), v...))
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x, y = x+1, y+1
			}
			v[off+k] = x
			if x >= n && y >= m {
				found = true
				trace = append(trace, append([]int(nil), v...))
				break
			}
		}
	}
	if !found {
		return nil, false
	}
	// 回溯：trace[d+1] 是第 d 轮结束时的 V
	var rev []diffSeg
	x, y := n, m
	for d := len(trace) - 2; d >= 0 && (x > 0 || y > 0); d-- {
		vv := trace[d]
		k := x - y
		var pk int
		if k == -d || (k != d && vv[off+k-1] < vv[off+k+1]) {
			pk = k + 1
		} else {
			pk = k - 1
		}
		px := vv[off+pk]
		py := px - pk
		for x > px && y > py {
			x, y = x-1, y-1
			rev = append(rev, diffSeg{diffEq, a[x]})
		}
		if d > 0 {
			if x == px {
				y--
				rev = append(rev, diffSeg{diffIns, b[y]})
			} else {
				x--
				rev = append(rev, diffSeg{diffDel, a[x]})
			}
		}
		x, y = px, py
	}
	for x > 0 && y > 0 { // d=0 的公共前缀
		x, y = x-1, y-1
		rev = append(rev, diffSeg{diffEq, a[x]})
	}
	out := make([]diffSeg, len(rev))
	for i, s := range rev {
		out[len(rev)-1-i] = s
	}
	return out, true
}

// diffSides：拆成左（原文：相同 + 删除）与右（将发送：相同 + 新增）两栏，并数出改动处数。
func diffSides(segs []diffSeg) (left, right []diffSeg, changes int) {
	prevChange := false
	for _, s := range segs {
		switch s.kind {
		case diffEq:
			left, right = append(left, s), append(right, s)
			prevChange = false
		case diffDel:
			left = append(left, s)
		case diffIns:
			right = append(right, s)
		}
		if s.kind != diffEq {
			if !prevChange {
				changes++
			}
			prevChange = true
		}
	}
	return
}
