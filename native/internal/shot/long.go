package shot

import (
	"slices"
	"time"
)

// 长截屏拼接：连续截取选区，按相邻帧重叠区域对齐并拼接，支持往回滚不重复追加，
// 自动排除固定页头 / 页尾与边缘滚动条，容忍亚像素滚动、抗锯齿与局部悬停变化。

const (
	LongMaxPixels  = 50_000_000 // 长图像素上限（约 200MB RGBA），超出即停
	minMatchRatio  = 0.6        // 有效重叠：非空白且非静态行里至少这么多比例对得上
	minOverlapRows = 12
	minVotes       = 3 // 至少这么多有效行对上，才算找到重叠
	LongIdleLimit  = 120 * time.Second
	LongPreviewW   = 400 // 预览图宽度（像素），最近邻缩小、只追加新行
	LongPanelW     = 220.0
	LongPanelMinH  = 320.0
	LongPanelGap   = 12.0
	LongFramePad   = 4.0 // 边框窗比选区每边大出的 pt（画在选区外，不会被截进去）
	LongMinCrop    = 16.0
	longFNVOffset  = 0xcbf29ce484222325
	longFNVPrime   = 0x100000001b3

	rowBins         = 32  // 每行水平分桶数（RGB × 32）
	rowBlankTol     = 4   // 真实画面行内最大通道差 <= 此值视作纯色空白行
	rowBinCap       = 40  // 单桶误差上限：压住局部悬浮钮 / 滚动条等局部噪声
	rowMatchAbsTol  = 110 // 容错匹配：平均每桶截断通道差 <= 11.0（×10 定点）
	rowMatchRelTol  = 34  // 容错匹配：去均值结构相对误差 <= 0.34（×100 定点）
	rowFixedAbsTol  = 50  // 固定页头/页尾与静态区判定：平均通道差 <= 5.0
	rowFixedRelTol  = 14  // 固定页头/页尾与静态区判定：结构相对误差 <= 0.14
	rowMaxMeanErr   = 110 // 整段重叠的平均截断组合误差上限（×10 定点）
	minStaticBand   = 4   // 连续静态非空白行达到此高度才视作固定浮层 / 吸顶栏
	minCommitHeight = 120 // 帧高达到此值时，小步长暂存待凑整或停顿后再切缝，消除 60fps 亚像素漂移
	maxCommitStep   = 32
)

// RowSig：每行的精确哈希、是否纯色，以及用于容错对齐的水平分桶均值 RGB。
type RowSig struct {
	Hash  uint64
	Blank bool
	Bins  [rowBins * 3]uint8
	Mean  [3]uint8
	NBins uint8
}

// RowSignatures 为一帧 RGBA 像素计算每行特征。
// 宽度 >= 240 时对齐特征自动忽略最右侧滚动条区域（min(24, w/20) 像素），不影响最终拼出的原图。
func RowSignatures(rgba []byte, w, h int) []RowSig {
	out := make([]RowSig, h)
	if w <= 0 || h <= 0 {
		return out
	}
	effW := w
	if w >= 240 {
		effW = w - min(24, w/20)
	}
	nb := min(effW, rowBins)
	blankTol := rowBlankTol
	if nb < 8 {
		blankTol = 0
	}
	strideX := 1
	if effW > 512 {
		strideX = 2
	}
	for y := range h {
		row := rgba[y*w*4 : (y+1)*w*4]
		hash := uint64(longFNVOffset)
		r0, g0, b0 := int(row[0]), int(row[1]), int(row[2])
		blank := true
		var sumR, sumG, sumB, totalCnt int
		var sig RowSig
		sig.NBins = uint8(nb)
		for bi := range nb {
			x0 := bi * effW / nb
			x1 := (bi + 1) * effW / nb
			var br, bg, bb, bc int
			for x := x0; x < x1; x += strideX {
				o := x * 4
				pr, pg, pb := row[o], row[o+1], row[o+2]
				hash ^= uint64(pr)
				hash *= longFNVPrime
				hash ^= uint64(pg)
				hash *= longFNVPrime
				hash ^= uint64(pb)
				hash *= longFNVPrime
				if blank && (absInt(int(pr)-r0) > blankTol || absInt(int(pg)-g0) > blankTol || absInt(int(pb)-b0) > blankTol) {
					blank = false
				}
				br += int(pr)
				bg += int(pg)
				bb += int(pb)
				bc++
			}
			if bc > 0 {
				sig.Bins[bi*3] = uint8(br / bc)
				sig.Bins[bi*3+1] = uint8(bg / bc)
				sig.Bins[bi*3+2] = uint8(bb / bc)
				sumR += br
				sumG += bg
				sumB += bb
				totalCnt += bc
			}
		}
		if totalCnt > 0 {
			sig.Mean = [3]uint8{uint8(sumR / totalCnt), uint8(sumG / totalCnt), uint8(sumB / totalCnt)}
		}
		sig.Hash = hash
		sig.Blank = blank
		out[y] = sig
	}
	return out
}

// uniqueRows：帧内独一无二的非空白行：哈希 → 行号（重复出现的记 -1）。
func uniqueRows(rows []RowSig, skip []bool) map[uint64]int {
	seen := make(map[uint64]int, len(rows))
	for i, r := range rows {
		if r.Blank || (skip != nil && skip[i]) {
			continue
		}
		if _, ok := seen[r.Hash]; ok {
			seen[r.Hash] = -1
		} else {
			seen[r.Hash] = i
		}
	}
	return seen
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// rowMetrics 返回两行的绝对分桶误差（×10 定点，0..400）与去均值结构相对误差（×100 定点，0..100）。
// 绝对误差用截断 L1 抗局部噪声；结构误差区分「白底上两行不同的短文字」。
func rowMetrics(a, b *RowSig) (absErr, relErr int) {
	if a.Hash != 0 && a.Hash == b.Hash && a.NBins == b.NBins {
		return 0, 0
	}
	nb := min(int(a.NBins), int(b.NBins))
	if nb == 0 {
		return 400, 100
	}
	ma0, ma1, ma2 := int(a.Mean[0]), int(a.Mean[1]), int(a.Mean[2])
	mb0, mb1, mb2 := int(b.Mean[0]), int(b.Mean[1]), int(b.Mean[2])
	capVal := rowBinCap
	if nb < 8 {
		capVal = 64
	}
	sumAbs, sumStructDiff, sumEnergy := 0, 0, 0
	for i := range nb {
		o := i * 3
		ar, ag, ab := int(a.Bins[o]), int(a.Bins[o+1]), int(a.Bins[o+2])
		br, bg, bb := int(b.Bins[o]), int(b.Bins[o+1]), int(b.Bins[o+2])
		d := max(absInt(ar-br), absInt(ag-bg), absInt(ab-bb))
		sumAbs += min(d, capVal)

		dar, dag, dab := ar-ma0, ag-ma1, ab-ma2
		dbr, dbg, dbb := br-mb0, bg-mb1, bb-mb2
		sd := absInt(dar-dbr) + absInt(dag-dbg) + absInt(dab-dbb)
		en := absInt(dar) + absInt(dag) + absInt(dab) + absInt(dbr) + absInt(dbg) + absInt(dbb)
		sumStructDiff += sd
		sumEnergy += en
	}
	absErr = sumAbs * 10 / nb
	if sumEnergy > nb*6 {
		relErr = sumStructDiff * 100 / sumEnergy
	}
	return absErr, relErr
}

// rowErrCombined：用于候选排序的综合单行误差（×10 定点）。
func rowErrCombined(a, b *RowSig) int {
	absErr, relErr := rowMetrics(a, b)
	return absErr + relErr
}

func rowTols(nb uint8) (absTol, relTol, maxMean int) {
	if nb < 8 { // 极窄画面无水平分桶平滑，用更紧阈值防止近周期合成行误匹配
		return 30, 12, 45
	}
	return rowMatchAbsTol, rowMatchRelTol, rowMaxMeanErr
}

func rowsMatch(a, b *RowSig) bool {
	absErr, relErr := rowMetrics(a, b)
	absTol, relTol, _ := rowTols(min(a.NBins, b.NBins))
	return absErr <= absTol && relErr <= relTol
}

func rowsFixed(a, b *RowSig) bool {
	if a.Hash != 0 && a.Hash == b.Hash {
		return true
	}
	nb := min(a.NBins, b.NBins)
	absErr, relErr := rowMetrics(a, b)
	if a.Blank && b.Blank {
		return absErr <= 25
	}
	if a.Blank != b.Blank {
		return false
	}
	if nb < 8 {
		return absErr <= 15 && relErr <= 8
	}
	return absErr <= rowFixedAbsTol && relErr <= rowFixedRelTol
}

// staticRowMask 找出前后帧同位置几乎未动的连续非空白带（未被 fixedRows 剥掉的吸顶栏 / 悬浮控件）。
// 帧内重复出现的分隔线 / 底纹不视作静态栏，避免误屏蔽真实滚动内容。
func staticRowMask(prev, next []RowSig, repPrev, repNext []bool) (mask []bool, nonBlank, staticCount int) {
	h := len(prev)
	raw := make([]bool, h)
	for r := range h {
		if prev[r].Blank && next[r].Blank {
			continue
		}
		nonBlank++
		if repPrev != nil && repNext != nil && repPrev[r] && repNext[r] {
			continue
		}
		if rowsFixed(&prev[r], &next[r]) {
			raw[r] = true
			staticCount++
		}
	}
	mask = make([]bool, h)
	for r := 0; r < h; {
		if !raw[r] {
			r++
			continue
		}
		end := r
		for end < h && (raw[end] || (prev[end].Blank && next[end].Blank)) {
			end++
		}
		nb := 0
		for k := r; k < end; k++ {
			if raw[k] {
				nb++
			}
		}
		if nb >= minStaticBand {
			for k := r; k < end; k++ {
				if raw[k] {
					mask[k] = true
				}
			}
		}
		r = end
	}
	return mask, nonBlank, staticCount
}

func downsampleRows(rows []RowSig, staticMask []bool, step int) ([]RowSig, []bool) {
	if step <= 1 {
		return rows, staticMask
	}
	hc := len(rows) / step
	out := make([]RowSig, hc)
	st := make([]bool, hc)
	for i := range hc {
		base := i * step
		nb := int(rows[base].NBins)
		var binSum [rowBins * 3]int
		var meanSum [3]int
		allBlank := true
		staticN := 0
		for k := range step {
			r := &rows[base+k]
			if !r.Blank {
				allBlank = false
			}
			if staticMask != nil && staticMask[base+k] {
				staticN++
			}
			for j := range nb * 3 {
				binSum[j] += int(r.Bins[j])
			}
			meanSum[0] += int(r.Mean[0])
			meanSum[1] += int(r.Mean[1])
			meanSum[2] += int(r.Mean[2])
		}
		out[i].NBins = uint8(nb)
		out[i].Blank = allBlank
		for j := range nb * 3 {
			out[i].Bins[j] = uint8(binSum[j] / step)
		}
		out[i].Mean = [3]uint8{uint8(meanSum[0] / step), uint8(meanSum[1] / step), uint8(meanSum[2] / step)}
		st[i] = staticN*2 >= step
	}
	return out, st
}

// repeatingRows 标出帧内重复出现 >= 3 次的非空白行（如分隔线、双色底纹），
// 这类行在多个错误偏移下都能巧合对齐，不能单独充当有效匹配票。
func repeatingRows(rows []RowSig) []bool {
	cnt := make(map[uint64]int, len(rows))
	for _, r := range rows {
		if !r.Blank {
			cnt[r.Hash]++
		}
	}
	rep := make([]bool, len(rows))
	for i, r := range rows {
		if !r.Blank && cnt[r.Hash] >= 3 {
			rep[i] = true
		}
	}
	return rep
}

type evalResult struct {
	dy            int
	considered    int
	exactMatched  int
	fuzzyMatched  int
	uniqueMatched int
	meanErr       int
	ok            bool
}

func evalOffset(prev, next []RowSig, staticMask, repPrev, repNext []bool, dy int) evalResult {
	h := len(prev)
	absTol, relTol, maxMean := rowTols(min(prev[0].NBins, next[0].NBins))
	considered, exactMatched, fuzzyMatched, uniqueMatched, sumErr := 0, 0, 0, 0, 0
	r0 := max(0, -dy)
	r1 := min(h, h-dy)
	for r := r0; r < r1; r++ {
		p := r + dy
		if prev[p].Blank && next[r].Blank {
			continue
		}
		if staticMask != nil && (staticMask[p] || staticMask[r]) {
			continue
		}
		considered++
		isRep := (repPrev != nil && repPrev[p]) || (repNext != nil && repNext[r])
		if prev[p].Hash != 0 && prev[p].Hash == next[r].Hash {
			exactMatched++
			fuzzyMatched++
			if !isRep {
				uniqueMatched++
			}
			continue
		}
		absErr, relErr := rowMetrics(&prev[p], &next[r])
		// 单行误差封顶：避免少量局部遮挡（如悬停卡片 / 移动滑块）拉爆整段均值
		sumErr += min(absErr+relErr, 180)
		if absErr <= absTol && relErr <= relTol {
			fuzzyMatched++
			if !isRep {
				uniqueMatched++
			}
		}
	}
	if considered < minVotes || fuzzyMatched < minVotes || uniqueMatched < minVotes {
		return evalResult{dy: dy, considered: considered, exactMatched: exactMatched, fuzzyMatched: fuzzyMatched, uniqueMatched: uniqueMatched, meanErr: 9999}
	}
	meanErr := sumErr / considered
	exactOK := exactMatched >= minVotes && float64(exactMatched) >= minMatchRatio*float64(considered)
	fuzzyOK := float64(fuzzyMatched) >= minMatchRatio*float64(considered) && meanErr <= maxMean
	return evalResult{dy: dy, considered: considered, exactMatched: exactMatched, fuzzyMatched: fuzzyMatched, uniqueMatched: uniqueMatched, meanErr: meanErr, ok: exactOK || fuzzyOK}
}

// evalOffsetHalf 检测半像素位移（dy + 0.5）：1× / 缩放屏平滑滚动落在两行像素中间时，
// 新帧每行近似等于上一帧相邻两行的均值；通过整帧统一的 +0.5 物理模型避免放宽误匹配。
func evalOffsetHalf(prev, next []RowSig, staticMask, repPrev, repNext []bool, dy int) evalResult {
	h := len(prev)
	nb := min(prev[0].NBins, next[0].NBins)
	if nb < 8 {
		return evalResult{dy: dy, meanErr: 9999}
	}
	absTol, relTol, maxMean := rowTols(nb)
	considered, fuzzyMatched, uniqueMatched, sumErr := 0, 0, 0, 0
	r0 := max(0, -dy)
	r1 := min(h, h-dy-1)
	var mid RowSig
	mid.NBins = nb
	for r := r0; r < r1; r++ {
		p := r + dy
		if prev[p].Blank && prev[p+1].Blank && next[r].Blank {
			continue
		}
		if staticMask != nil && (staticMask[p] || staticMask[p+1] || staticMask[r]) {
			continue
		}
		considered++
		for j := range int(nb) * 3 {
			mid.Bins[j] = uint8((int(prev[p].Bins[j]) + int(prev[p+1].Bins[j]) + 1) >> 1)
		}
		mid.Mean = [3]uint8{
			uint8((int(prev[p].Mean[0]) + int(prev[p+1].Mean[0]) + 1) >> 1),
			uint8((int(prev[p].Mean[1]) + int(prev[p+1].Mean[1]) + 1) >> 1),
			uint8((int(prev[p].Mean[2]) + int(prev[p+1].Mean[2]) + 1) >> 1),
		}
		absErr, relErr := rowMetrics(&mid, &next[r])
		sumErr += min(absErr+relErr, 180)
		if absErr <= absTol && relErr <= relTol {
			fuzzyMatched++
			if !((repPrev != nil && repPrev[p] && repPrev[p+1]) || (repNext != nil && repNext[r])) {
				uniqueMatched++
			}
		}
	}
	if considered < minVotes || fuzzyMatched < minVotes || uniqueMatched < minVotes {
		return evalResult{dy: dy, considered: considered, fuzzyMatched: fuzzyMatched, uniqueMatched: uniqueMatched, meanErr: 9999}
	}
	meanErr := sumErr / considered
	ok := float64(fuzzyMatched) >= minMatchRatio*float64(considered) && meanErr <= maxMean
	return evalResult{dy: dy, considered: considered, fuzzyMatched: fuzzyMatched, uniqueMatched: uniqueMatched, meanErr: meanErr, ok: ok}
}

// ScrollOffset：新帧相对上一帧的位移：上一帧第 r+dy 行 == 新帧第 r 行。正 = 往下滚，负 = 往回滚，
// 0 = 没滚（画面原地小变）。先走唯一行哈希快速投票，未命中时再走由粗到细的容错分桶对齐，
// 自动排除静态浮层并做显著性复核，避免重复条纹或纯色区域误对齐。
func ScrollOffset(prev, next []RowSig) (int, bool) {
	h := min(len(prev), len(next))
	if h < minVotes {
		return 0, false
	}
	prev, next = prev[:h], next[:h]
	repPrev := repeatingRows(prev)
	repNext := repeatingRows(next)
	staticMask, nonBlank, staticCount := staticRowMask(prev, next, repPrev, repNext)
	if nonBlank == 0 {
		return 0, false
	}
	// 画面几乎未滚（仅光标闪烁或极小局部变化）：返回 dy=0，不触发接不上。
	if nonBlank >= minVotes && float64(staticCount) >= 0.92*float64(nonBlank) {
		return 0, true
	}

	minOv := min(minOverlapRows, max(minVotes, h/4))
	maxDy := h - minOv
	maxExactDy := h - minVotes
	if maxExactDy < 1 {
		return 0, false
	}

	// 阶段 1：唯一行哈希投票（排除 dy=0，防止吸顶栏/页尾抢票；精确哈希允许大步长到 h-minVotes）。
	cands := make([]int, 0, 16)
	seenCand := map[int]bool{}
	addCand := func(dy int) {
		if dy == 0 || absInt(dy) > maxDy || seenCand[dy] {
			return
		}
		seenCand[dy] = true
		cands = append(cands, dy)
	}

	at := uniqueRows(prev, staticMask)
	votes := map[int]int{}
	for hash, r := range uniqueRows(next, staticMask) {
		if p, ok := at[hash]; ok && r >= 0 && p >= 0 {
			if dy := p - r; dy != 0 && absInt(dy) <= maxExactDy {
				votes[dy]++
			}
		}
	}
	type dyVote struct{ dy, n int }
	var topVotes []dyVote
	for dy, c := range votes {
		if c >= minVotes {
			topVotes = append(topVotes, dyVote{dy, c})
		}
	}
	slices.SortFunc(topVotes, func(a, b dyVote) int {
		if a.n != b.n {
			return b.n - a.n
		}
		return absInt(a.dy) - absInt(b.dy)
	})
	for i := 0; i < min(len(topVotes), 4); i++ {
		res := evalOffset(prev, next, staticMask, repPrev, repNext, topVotes[i].dy)
		if res.ok && float64(res.exactMatched) >= minMatchRatio*float64(res.considered) {
			return res.dy, true
		}
		addCand(topVotes[i].dy)
	}

	// 阶段 2：由粗到细的容错分桶搜索（应对亚像素滚动、抗锯齿、滚动条、半透明底）。
	step := 1
	switch {
	case h >= 200:
		step = 4
	case h >= 80:
		step = 2
	}
	cPrev, cStatic := downsampleRows(prev, staticMask, step)
	cNext, _ := downsampleRows(next, staticMask, step)
	hc := len(cPrev)
	minOvC := max(2, minOv/step)
	maxDyC := hc - minOvC
	if maxDyC >= 1 {
		var allAnchors []int
		for r := range hc {
			if !cNext[r].Blank && !cStatic[r] {
				allAnchors = append(allAnchors, r)
			}
		}
		if len(allAnchors) >= 2 {
			anchors := allAnchors
			const maxAnchors = 48
			if len(anchors) > maxAnchors {
				sampled := make([]int, maxAnchors)
				for i := range maxAnchors {
					sampled[i] = allAnchors[i*(len(allAnchors)-1)/(maxAnchors-1)]
				}
				anchors = sampled
			}
			type coarseScore struct {
				dyC int
				err int
			}
			// 分别记录中小位移（<= 半屏，覆盖绝大多数平滑滚屏）与大位移（> 半屏，覆盖快速大跳），
			// 避免边缘极小重叠区（仅剩 2–3 个锚点）的偶发低误差挤掉真实位移。
			var nearScores, farScores []coarseScore
			halfDyC := max(1, hc/2)
			for dyC := -maxDyC; dyC <= maxDyC; dyC++ {
				if dyC == 0 {
					continue
				}
				sum, cnt := 0, 0
				for _, r := range anchors {
					p := r + dyC
					if p < 0 || p >= hc || cStatic[p] {
						continue
					}
					if cPrev[p].Blank && cNext[r].Blank {
						continue
					}
					sum += rowErrCombined(&cPrev[p], &cNext[r])
					cnt++
				}
				minReq := min(3, max(2, len(anchors)/4))
				if cnt >= minReq {
					sc := coarseScore{dyC, sum / cnt}
					if absInt(dyC) <= halfDyC {
						nearScores = append(nearScores, sc)
					} else {
						farScores = append(farScores, sc)
					}
				}
			}
			pickTop := func(list []coarseScore, limit int) {
				slices.SortFunc(list, func(a, b coarseScore) int {
					if a.err != b.err {
						return a.err - b.err
					}
					return absInt(a.dyC) - absInt(b.dyC)
				})
				var picked []int
				for _, sc := range list {
					far := true
					for _, old := range picked {
						if absInt(sc.dyC-old) <= 1 {
							far = false
							break
						}
					}
					if !far {
						continue
					}
					picked = append(picked, sc.dyC)
					for d := -step; d <= step; d++ {
						addCand(sc.dyC*step + d)
					}
					if len(picked) >= limit {
						break
					}
				}
			}
			pickTop(nearScores, 5)
			pickTop(farScores, 4)
		}
	}

	if len(cands) == 0 {
		return 0, false
	}

	// 阶段 3：全分辨率精核（含对最优候选的 0.5px 亚像素偏移）+ 显著性校验。
	best := evalResult{meanErr: 9999}
	consider := func(res evalResult) {
		if !res.ok {
			return
		}
		if !best.ok || res.meanErr < best.meanErr ||
			(res.meanErr == best.meanErr && res.fuzzyMatched > best.fuzzyMatched) ||
			(res.meanErr == best.meanErr && res.fuzzyMatched == best.fuzzyMatched && absInt(res.dy) < absInt(best.dy)) {
			best = res
		}
	}
	nb := min(prev[0].NBins, next[0].NBins)
	evals := make([]evalResult, 0, len(cands))
	for _, dy := range cands {
		res := evalOffset(prev, next, staticMask, repPrev, repNext, dy)
		evals = append(evals, res)
		consider(res)
	}
	// 仅对误差最低的前 4 个整数候选补检 ±0.5px 亚像素位移，兼顾速度与 1× 屏半像素精度
	if nb >= 8 && (!best.ok || best.exactMatched < minVotes) {
		slices.SortFunc(evals, func(a, b evalResult) int {
			if a.meanErr != b.meanErr {
				return a.meanErr - b.meanErr
			}
			return absInt(a.dy) - absInt(b.dy)
		})
		testedHalf := map[int]bool{}
		for i := 0; i < min(len(evals), 4); i++ {
			for _, hdy := range []int{evals[i].dy - 1, evals[i].dy} {
				if hdy == 0 || hdy+1 == 0 || absInt(hdy) > maxDy || absInt(hdy+1) > maxDy || testedHalf[hdy] {
					continue
				}
				testedHalf[hdy] = true
				if hres := evalOffsetHalf(prev, next, staticMask, repPrev, repNext, hdy); hres.ok {
					lo := evalOffset(prev, next, staticMask, repPrev, repNext, hdy)
					hi := evalOffset(prev, next, staticMask, repPrev, repNext, hdy+1)
					if hi.meanErr < lo.meanErr {
						hres.dy = hdy + 1
					}
					consider(hres)
				}
			}
		}
	}
	if !best.ok {
		return 0, false
	}
	if best.exactMatched >= minVotes && float64(best.exactMatched) >= minMatchRatio*float64(best.considered) {
		return best.dy, true
	}

	// 显著性复核：真实位移的误差应明显低于错位偏移（防止纯低对比度/重复底纹误匹配）。
	var refErrs []int
	for _, delta := range []int{-12, -6, 6, 12, -24, 24} {
		alt := best.dy + delta
		if alt == 0 || absInt(alt) > maxDy {
			continue
		}
		r := evalOffset(prev, next, staticMask, repPrev, repNext, alt)
		if r.considered >= minVotes {
			refErrs = append(refErrs, r.meanErr)
		}
	}
	if len(refErrs) >= 2 {
		slices.Sort(refErrs)
		medianRef := refErrs[len(refErrs)/2]
		if best.meanErr*100 > medianRef*65 && medianRef > 20 {
			return 0, false
		}
	}
	return best.dy, true
}

// fixedRows：相邻两帧在原位几乎不变的顶部 / 底部行数（固定页头、固定页尾）。
func fixedRows(prev, next []RowSig) (top, bottom int) {
	h := min(len(prev), len(next))
	for top < h && rowsFixed(&prev[top], &next[top]) {
		top++
	}
	for r := h - 1; r >= top && rowsFixed(&prev[r], &next[r]); r-- {
		bottom++
	}
	return
}

type Push int

const (
	Appended  Push = iota
	Same           // 与上一帧完全相同（到底了）
	NoOverlap      // 接不上（滚太快）
	Moved          // 往回滚，或往下滚但还没越过已拼部分 / 暂存小步长
)

// Stitcher 逐帧拼接。
type Stitcher struct {
	W, H   int
	Out    []byte
	TotalH int
	prev   []RowSig
	tail   int // 长图末尾有多少行是上一帧底部的原样像素（摘页尾不能超过它）
	behind int // 当前帧内容底边比已拼长图底边高出的行数（往回滚产生）
	// 暂存的微小步长帧：60fps 亚像素慢滚时避免每 1–3px 切缝累积漂移；凑够步长、停滚或完成时落盘
	pending    []byte
	pendingSig []RowSig
	pendingDy  int
	pendingBot int
	// 诊断：相邻两帧最大位移；接不上的帧之间能互相对齐的次数
	MaxStep                int
	lost                   []RowSig
	LostPairs, LostAligned int
}

func NewStitcher(first []byte, w, h int) *Stitcher {
	out := make([]byte, len(first))
	copy(out, first)
	return &Stitcher{W: w, H: h, Out: out, TotalH: h, prev: RowSignatures(first, w, h), tail: h}
}

func sigEqual(a, b []RowSig) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Hash != b[i].Hash || a[i].Blank != b[i].Blank {
			return false
		}
	}
	return true
}

func (s *Stitcher) minCommitStep() int {
	if s.H < minCommitHeight {
		return 1
	}
	return min(maxCommitStep, s.H/10)
}

func (s *Stitcher) commitFrame(frame []byte, sig []RowSig, dy, bottom int) {
	w, h := s.W, s.H
	n := min(dy-s.behind, h-bottom)
	s.behind = 0
	s.pending, s.pendingSig, s.pendingDy, s.pendingBot = nil, nil, 0, 0
	if n <= 0 {
		s.prev = sig
		return
	}
	// 摘掉旧页尾 → 接上新帧页尾之上的 n 行新内容 + 新页尾
	strip := min(bottom, s.tail)
	s.Out = append(s.Out[:len(s.Out)-strip*w*4], frame[(h-strip-n)*w*4:]...)
	s.TotalH += n
	s.tail = n + strip
	s.prev = sig
}

// Flush 把暂存的微小步长帧落盘；若有新内容写入返回 true。
func (s *Stitcher) Flush() bool {
	if s.pending == nil {
		return false
	}
	s.commitFrame(s.pending, s.pendingSig, s.pendingDy, s.pendingBot)
	return true
}

func (s *Stitcher) alignAgainstPrev(sig []RowSig) (dy, bottom int, ok bool) {
	h := s.H
	top, bottom := fixedRows(s.prev, sig)
	if top+bottom+2*minOverlapRows >= h {
		top, bottom = 0, 0
	}
	bottom = min(bottom, s.tail)
	dy, ok = ScrollOffset(s.prev[top:h-bottom], sig[top:h-bottom])
	return dy, bottom, ok
}

func (s *Stitcher) Push(frame []byte) Push {
	w, h := s.W, s.H
	sig := RowSignatures(frame, w, h)
	// 画面静止：若有暂存小步长，立刻落盘让预览反映最新画面
	if s.pendingSig != nil && sigEqual(sig, s.pendingSig) {
		s.Flush()
		return Appended
	}
	if sigEqual(sig, s.prev) {
		if s.pending != nil {
			s.pending, s.pendingSig, s.pendingDy, s.pendingBot = nil, nil, 0, 0
		}
		return Same
	}
	flushed := false
	dy, bottom, ok := s.alignAgainstPrev(sig)
	// 若与锚点没对上但手里有暂存帧，先把暂存帧落盘推进锚点再试一次
	if !ok && s.pending != nil {
		flushed = s.Flush()
		dy, bottom, ok = s.alignAgainstPrev(sig)
	}
	if !ok {
		if s.lost != nil {
			s.LostPairs++
			if d, ok := ScrollOffset(s.lost, sig); ok && d != 0 {
				s.LostAligned++
			}
		}
		s.lost = sig
		if flushed {
			return Appended
		}
		return NoOverlap
	}
	s.lost = nil
	s.MaxStep = max(s.MaxStep, absInt(dy))
	if dy <= 0 {
		s.pending, s.pendingSig, s.pendingDy, s.pendingBot = nil, nil, 0, 0
		s.behind += -dy
		s.moved(sig, bottom)
		if flushed {
			return Appended
		}
		return Moved
	}
	if dy <= s.behind {
		s.pending, s.pendingSig, s.pendingDy, s.pendingBot = nil, nil, 0, 0
		s.behind -= dy
		s.moved(sig, bottom)
		if flushed {
			return Appended
		}
		return Moved
	}
	n := dy - s.behind
	if n < s.minCommitStep() {
		cp := make([]byte, len(frame))
		copy(cp, frame)
		s.pending, s.pendingSig, s.pendingDy, s.pendingBot = cp, sig, dy, bottom
		if flushed {
			return Appended
		}
		return Moved
	}
	s.commitFrame(frame, sig, dy, bottom)
	return Appended
}

func (s *Stitcher) moved(sig []RowSig, bottom int) {
	s.tail = min(s.tail, bottom)
	s.prev = sig
}

// Stop 是长截屏的结束原因。
type Stop int

const (
	StopNone Stop = iota
	StopFinished
	StopCancelled
	StopIdle
	StopLimit
)

// LongStats：逐帧统计（诊断用：区分「滚太快」与「内容对不上」）。
type LongStats struct {
	Frames, Misses, LongestMissRun int
	CaptureMs                      int64
}

// Follow 定时截帧，画面变了就拼；对不上的帧丢弃（等用户往回滚到能接上）。
// stop 返回面板按钮的请求；stitched 每次追加后回调，stalled 在接不上 / 恢复时回调。
func Follow(st *Stitcher, capture func() ([]byte, int, int, error), stop func() Stop, stitched func(), stalled func(bool), now func() time.Time) (Stop, LongStats, error) {
	if now == nil {
		now = time.Now
	}
	lastChange := now()
	var stats LongStats
	isStalled, missRun := false, 0
	for {
		if r := stop(); r != StopNone {
			if r != StopCancelled && st.Flush() && stitched != nil {
				stitched()
			}
			return r, stats, nil
		}
		if now().Sub(lastChange) > LongIdleLimit {
			if st.Flush() && stitched != nil {
				stitched()
			}
			return StopIdle, stats, nil
		}
		started := time.Now()
		frame, fw, fh, err := capture()
		stats.CaptureMs += time.Since(started).Milliseconds()
		if err != nil {
			return StopNone, stats, err
		}
		if fw != st.W || fh != st.H {
			return StopNone, stats, errFrameSize
		}
		res := st.Push(frame)
		stats.Frames++
		if res == NoOverlap {
			stats.Misses++
			missRun++
			stats.LongestMissRun = max(stats.LongestMissRun, missRun)
		} else {
			missRun = 0
		}
		if res != Same {
			lastChange = now()
		}
		if (res == NoOverlap) != isStalled {
			isStalled = !isStalled
			if stalled != nil {
				stalled(isStalled)
			}
		}
		if res == Appended {
			if stitched != nil {
				stitched()
			}
			if st.W*st.TotalH >= LongMaxPixels {
				return StopLimit, stats, nil
			}
		}
	}
}

type longErr string

func (e longErr) Error() string { return string(e) }

const errFrameSize = longErr("frame size changed")

// LongPanelRect：预览面板放选区右侧，放不下放左侧，都放不下贴屏幕右缘；纵向与选区顶对齐并收进屏内。
func LongPanelRect(display, region Rect) Rect {
	h := min(max(region.H, LongPanelMinH), display.H-2*LongPanelGap)
	right := region.X + region.W + LongPanelGap
	left := region.X - LongPanelGap - LongPanelW
	x := display.X + display.W - LongPanelW - LongPanelGap
	if right+LongPanelW <= display.X+display.W-LongPanelGap {
		x = right
	} else if left >= display.X+LongPanelGap {
		x = left
	}
	y := clamp(region.Y, display.Y+LongPanelGap, display.Y+display.H-h-LongPanelGap)
	return Rect{x, y, LongPanelW, h}
}

// LongPreview：按 LongPreviewW 最近邻缩小的预览，只追加尚未采样的行（预览第 k 行取源第 ⌊k·f⌋ 行）。
type LongPreview struct {
	RGBA []byte
	Rows int
}

func (p *LongPreview) Extend(src []byte, srcW, srcH int) {
	f := float64(srcW) / LongPreviewW
	for {
		sy := int(float64(p.Rows) * f)
		if sy >= srcH {
			return
		}
		row := src[sy*srcW*4 : (sy+1)*srcW*4]
		for k := range LongPreviewW {
			sx := min(int(float64(k)*f), srcW-1) * 4
			p.RGBA = append(p.RGBA, row[sx:sx+4]...)
		}
		p.Rows++
	}
}
