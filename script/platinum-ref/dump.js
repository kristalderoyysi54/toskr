// 在页面内执行：导出每个可见元素的坐标与计算样式（规格来源，比看图量像素可靠）。
(() => {
  const out = [];
  const hex = (s) => s.replace(/rgb\((\d+), (\d+), (\d+)\)/g, (_, r, g, b) => "#" + [r, g, b].map((x) => (+x).toString(16).padStart(2, "0")).join(""));
  const r1 = (x) => Math.round(x * 10) / 10;
  const walk = (el, depth) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const p = [];
    if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") p.push("bg=" + cs.backgroundColor);
    if (cs.backgroundImage !== "none") p.push("bgi=" + cs.backgroundImage.slice(0, 90));
    const bw = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat);
    if (bw.some((x) => x > 0)) p.push("bd=" + bw.join("/") + " " + cs.borderTopColor + (cs.borderTopStyle !== "solid" ? " " + cs.borderTopStyle : ""));
    if (cs.borderTopLeftRadius !== "0px") p.push("rad=" + cs.borderRadius);
    if (cs.boxShadow !== "none") p.push("sh=" + cs.boxShadow);
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) p.push("ol=" + cs.outlineWidth + " " + cs.outlineColor + " off" + cs.outlineOffset);
    if (cs.opacity !== "1") p.push("op=" + cs.opacity);
    if (cs.mixBlendMode !== "normal") p.push("blend=" + cs.mixBlendMode);
    const pad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
    if (pad.some((x) => x > 0)) p.push("pad=" + pad.join("/"));
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
    if (own) p.push(`txt="${own.slice(0, 24)}" ${cs.fontSize}/${cs.lineHeight} w${cs.fontWeight} ${cs.color}`);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") p.push(`ph="${el.placeholder}" ${cs.fontSize} ${cs.color}`);
    if (el.tagName === "svg") p.push("svg " + cs.color + " " + ((el.getAttribute("class") || "").match(/lucide-[\w-]+/) || [""])[0]);
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter((x) => /^(platinum|material|asset|panel|surface|list-|hud|floating)/.test(x)).join(".");
    const data = [...el.attributes].filter((a) => a.name.startsWith("data-") || a.name === "role" || a.name.startsWith("aria-")).map((a) => a.name.replace("data-", "d-") + (a.value ? "=" + a.value.slice(0, 18) : "")).join(" ");
    if (p.length || cls || data) out.push(`${" ".repeat(Math.min(depth, 14))}${el.tagName.toLowerCase()}${cls ? "." + cls : ""} [${r1(r.x)},${r1(r.y)} ${r1(r.width)}x${r1(r.height)}] ${hex(p.join(" | "))} ${data ? "{" + data + "}" : ""}`);
    if (el.tagName === "svg") return;
    for (const ch of el.children) walk(ch, depth + 1);
  };
  walk(document.body, 0);
  return out.join("\n");
})()
