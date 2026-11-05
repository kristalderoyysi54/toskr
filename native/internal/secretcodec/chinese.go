package secretcodec

import "strings"

// codebook 256 个常用汉字，索引即字节值。⚠️ 顺序即契约，与 chineseCodec.ts 一致，不可重排。
const codebook = "的一是了我不人在他有这个上们来到" +
	"时大地为子中你说生国年着就那和要" +
	"她出也得里后自以会家可下而过天去" +
	"能对小多然于心学么之都好看起发当" +
	"没成只如事把还用第样道想作种开美" +
	"总从无情己面最女但现前些所同日手" +
	"又行意动方期它头经长儿回位分爱老" +
	"因很给名法间斯知世什两次使身者被" +
	"高已亲其进此话常与活正感见明问力" +
	"理尔点文几定本公特做外孩相西果走" +
	"将月十实向声车全信重三机工物气每" +
	"并别真打太新比才便夫再书部水像眼" +
	"等体却加电主界门利海受听表德少克" +
	"代员许笑先口由死安写性马光白或住" +
	"难望教命花结乐色更拉东神记处让母" +
	"父应直字场平报友关放至张认接告入"

const (
	cnOpen  = "「"
	cnClose = "」"
)

// midMarks 中间标点候选（逗号为主）。
var midMarks = [...]string{"，", "，", "、", "；", "，", "。"}

var (
	cnTable   = []rune(codebook)
	cnReverse = func() map[rune]byte {
		m := make(map[rune]byte, len(cnTable))
		for i, r := range cnTable {
			m[r] = byte(i)
		}
		return m
	}()
)

// encodeChinese 字节 → 带「」与排版的中文密文（= encodeBytes）。
func encodeChinese(b []byte) string {
	var body strings.Builder
	sinceMark, sinceBreak := 0, 0
	for i, c := range b {
		body.WriteRune(cnTable[c])
		sinceMark++
		sinceBreak++
		if i == len(b)-1 {
			break
		}
		// 间隔由密文字节驱动
		if sinceBreak >= 22+int(c%9) {
			body.WriteByte('\n')
			sinceMark, sinceBreak = 0, 0
		} else if sinceMark >= 4+int(c%6) {
			body.WriteString(midMarks[int(c)%len(midMarks)])
			sinceMark = 0
		}
	}
	return cnOpen + body.String() + "。" + cnClose
}

// decodeChinese 中文密文 → 字节；有「」只取其间，只认码本字；无码本字返回 nil（= decodeToBytes）。
func decodeChinese(text string) []byte {
	region := text
	open := strings.Index(text, cnOpen)
	end := strings.LastIndex(text, cnClose)
	if open >= 0 && end > open {
		region = text[open+len(cnOpen) : end]
	}
	var out []byte
	for _, r := range region {
		if b, ok := cnReverse[r]; ok {
			out = append(out, b)
		}
	}
	return out
}

// looksLikeSecret 粗筛：含「」且码本字节数达 minBytes。
func looksLikeSecret(text string, minBytes int) bool {
	if !strings.Contains(text, cnOpen) || !strings.Contains(text, cnClose) {
		return false
	}
	b := decodeChinese(text)
	return b != nil && len(b) >= minBytes
}
