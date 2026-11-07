// Deterministic checks run in the page before each screenshot, through the headless-browser
// script's --eval: text contrast (WCAG AA), controls without an accessible name, tap
// targets under 24 px on narrow viewports, images without alt and horizontal overflow.
// They cost no model calls; a round compares their totals with the main branch's, so a
// design change cannot make them worse. Colors are resolved through a canvas, so any CSS
// color syntax works; text on background images or gradients is counted as unknown.
const SAMPLES = 6;

function pageChecks(narrowWidth, samples) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const probe = document.createElement("div");
  probe.style.background = "Canvas";
  document.documentElement.append(probe);
  const canvasColor = rgba(getComputedStyle(probe).backgroundColor);
  probe.remove();
  const luminance = ([r, g, b]) => {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 1 && box.height > 1 && style.visibility === "visible" && style.display !== "none";
  };
  // The color behind el: its own and its ancestors' backgrounds composited over the page.
  const background = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return null;
      const color = rgba(style.backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 0.999) break;
    }
    return layers.reverse().reduce((below, layer) => over(layer, below), canvasColor);
  };
  const opacity = (el) => {
    let value = 1;
    for (let node = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  const sample = (list, item) => {
    if (list.length < samples) list.push(item);
  };
  const short = (value) => value.replace(/\s+/g, " ").trim().slice(0, 50);

  const contrast = { count: 0, unknown: 0, checked: 0, samples: [] };
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg"].includes(el.tagName)) continue;
    const own = [...el.childNodes].filter((node) => node.nodeType === 3 && node.textContent.trim()).map((node) => node.textContent).join(" ");
    if (!own.trim() || !visible(el) || el.closest("[aria-hidden=true], :disabled, [aria-disabled=true]")) continue;
    const style = getComputedStyle(el);
    const behind = background(el);
    if (!behind) {
      contrast.unknown++;
      continue;
    }
    const color = rgba(style.color);
    const text = over([color[0], color[1], color[2], color[3] * opacity(el)], behind);
    const size = parseFloat(style.fontSize);
    const required = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    const value = ratio(text, behind);
    contrast.checked++;
    if (value < required) {
      contrast.count++;
      sample(contrast.samples, { text: short(own), ratio: Math.round(value * 100) / 100, required });
    }
  }

  const name = (el) => {
    const label = el.getAttribute("aria-label");
    if (label?.trim()) return label;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (text) return text;
    }
    if (el.labels?.length) {
      const text = [...el.labels].map((item) => item.textContent).join(" ").trim();
      if (text) return text;
    }
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && el.textContent.trim()) return el.textContent;
    for (const img of el.querySelectorAll("img[alt], [aria-label]")) {
      const text = (img.getAttribute("alt") ?? img.getAttribute("aria-label") ?? "").trim();
      if (text) return text;
    }
    for (const attribute of ["title", "placeholder"]) if (el.getAttribute(attribute)?.trim()) return el.getAttribute(attribute);
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) && el.value) return el.value;
    return "";
  };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`.slice(0, 80);
  const unlabeled = { count: 0, samples: [] };
  const targets = { count: 0, samples: [] };
  const narrow = window.innerWidth < narrowWidth;
  const controls = document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=switch], [role=tab], [role=menuitem]");
  for (const el of controls) {
    if (!visible(el)) continue;
    if (!name(el).trim()) {
      unlabeled.count++;
      sample(unlabeled.samples, describe(el));
    }
    // Links inside running text are exempt from the target size (WCAG 2.5.8).
    if (!narrow || (el.tagName === "A" && getComputedStyle(el).display === "inline")) continue;
    const boxes = [el, ...(el.labels ?? [])].map((node) => node.getBoundingClientRect());
    const width = Math.max(...boxes.map((box) => box.width));
    const height = Math.max(...boxes.map((box) => box.height));
    if (width < 24 || height < 24) {
      targets.count++;
      sample(targets.samples, `${describe(el)} ${Math.round(width)}x${Math.round(height)}`);
    }
  }

  return {
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    contrast,
    unlabeled,
    targets,
    missingAlt: [...document.querySelectorAll("img:not([alt])")].filter(visible).length,
  };
}

// The expression the browser evaluates.
export const pageChecksExpression = (narrowWidth) => `(${pageChecks.toString()})(${narrowWidth}, ${SAMPLES})`;

// Adds css to the page as a constructed style sheet, which a page's style-src policy does
// not block, and answers whether it applied.
export const injectCssExpression = (css) => `(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync(${JSON.stringify(css)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; return document.adoptedStyleSheets.includes(sheet); })()`;

// What the gates compare: totals over a version's shots.
export function checkTotals(shots) {
  const totals = { overflow: 0, contrast: 0, unlabeled: 0, targets: 0, missingAlt: 0 };
  for (const shot of shots) {
    const checks = shot.checks;
    if (!checks) continue;
    totals.overflow += checks.overflowX ? 1 : 0;
    totals.contrast += checks.contrast.count;
    totals.unlabeled += checks.unlabeled.count;
    totals.targets += checks.targets.count;
    totals.missingAlt += checks.missingAlt;
  }
  return totals;
}
