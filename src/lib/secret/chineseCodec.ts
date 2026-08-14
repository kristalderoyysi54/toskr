/**
 * 字节 ↔ 中文码本：每字节映射到一张 256 个常用汉字的固定表中的一个字。
 * 密文用「」包裹、按密文字节驱动插入标点/换行，读起来像一段被引用的散文诗胡话
 * （语义随机，不追求通顺——诚实基线）。解码时只认码本内汉字、剥除其余一切字符，
 * 故 IM 的换行/加空格/标点规范化都无损；「」给出收尾边界、抗少量前后聊天文字污染。
 *
 * ⚠️ 发布后冻结：CODEBOOK 内容与顺序一经用户产生密文即不可变更，否则存量密文
 *   永久无法解码。任何改动必须配合 crypto 版本号并保留旧表解码分支。
 */

/**
 * 256 个常用汉字，索引即字节值（0..255）。取自现代汉语高频字，去重、避生僻。
 * 顺序即契约（不可重排）；单测锚定长度/唯一性/若干固定索引以防误改。
 */
const CODEBOOK =
  "的一是了我不人在他有这个上们来到" +
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
  "父应直字场平报友关放至张认接告入";

/** 码本汉字数组（按码点切，稳妥支持将来若换含代理对的字）。 */
const TABLE = [...CODEBOOK];
/** 反查：汉字 → 字节值。 */
const REVERSE = new Map<string, number>(TABLE.map((ch, i) => [ch, i]));

/** 引用式收尾边界（自然中文标点，非码本字符，解码时剥除）。 */
const OPEN = "「";
const CLOSE = "」";
/** 中间标点候选（以逗号为主，偶见顿号/分号/句号，凑段落感）。 */
const MID_MARKS = ["，", "，", "、", "；", "，", "。"];

export const CODEC_CONSTANTS = { SIZE: TABLE.length, OPEN, CLOSE } as const;

/** 字节序列 → 带引号与排版的中文密文串。 */
export function encodeBytes(bytes: Uint8Array): string {
  let body = "";
  let sinceMark = 0;
  let sinceBreak = 0;
  for (let i = 0; i < bytes.length; i++) {
    body += TABLE[bytes[i]];
    sinceMark++;
    sinceBreak++;
    if (i === bytes.length - 1) break;
    const b = bytes[i];
    // 间隔由密文字节驱动 → 每条消息节奏不同，不呈机械等距
    if (sinceBreak >= 22 + (b % 9)) {
      body += "\n";
      sinceMark = 0;
      sinceBreak = 0;
    } else if (sinceMark >= 4 + (b % 6)) {
      body += MID_MARKS[b % MID_MARKS.length];
      sinceMark = 0;
    }
  }
  return OPEN + body + "。" + CLOSE;
}

/**
 * 中文密文串 → 字节；无任何码本字符返回 null。
 * 若存在「」则只取其间区域（抗前后聊天文字），否则全文扫描；只认码本汉字。
 */
export function decodeToBytes(text: string): Uint8Array | null {
  let region = text;
  const open = text.indexOf(OPEN);
  const close = text.lastIndexOf(CLOSE);
  if (open >= 0 && close > open) {
    region = text.slice(open + OPEN.length, close);
  }
  const bytes: number[] = [];
  for (const ch of region) {
    const b = REVERSE.get(ch);
    if (b !== undefined) bytes.push(b);
  }
  return bytes.length ? Uint8Array.from(bytes) : null;
}

/**
 * 廉价预判文本是否像秘文：含「」边界且其间码本字节数达最小信封长度。
 * 仅作粗筛，是否真为秘文由 secret 层的魔数校验与 GCM 试解权威判定。
 */
export function looksLikeSecret(text: string, minBytes: number): boolean {
  if (text.indexOf(OPEN) < 0 || text.lastIndexOf(CLOSE) < 0) return false;
  const bytes = decodeToBytes(text);
  return bytes !== null && bytes.length >= minBytes;
}
