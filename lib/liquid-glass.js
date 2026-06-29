/**
 * Liquid Glass — 苹果 WWDC25 液态玻璃效果 Web 实现
 * 
 * 方案：Canvas SDF 位移贴图 + SVG feDisplacementMap + CSS 菲涅尔高光 + 鼠标跟随
 * 零依赖，约 200 行
 * 
 * 用法：
 *   1. 页面里放一个隐藏 <svg id="liquid-glass-svg"><filter id="liquid-glass">...</filter></svg>
 *   2. 给玻璃元素加 class="glass" 或 data-glass
 *   3. LiquidGlass.boot()
 * 
 * 核心原理：roundedRectSDF 计算每个像素到圆角矩形边缘的距离，
 * 只在边缘区域产生位移值，中间保持中性 128（无位移），
 * 喂给 feDisplacementMap 实现"边缘折射、中间不变形"的苹果 Liquid Glass 特征。
 */

(function () {
  'use strict';

  const LIQUID_GLASS = {
    /** 边缘位移阈值（SDF 值 < 此阈值的像素才产生位移） */
    edgeThreshold: 40,
    /** 折射强度（feDisplacementMap scale） */
    refractionScale: 25,
    /** 位移贴图分辨率（每个玻璃元素的宽度比例） */
    mapDensity: 1.0,
    /** ResizeObserver debounce ms */
    resizeDebounce: 120,
    /** 鼠标高光过渡 ms */
    highlightTransition: '0.3s ease-out',

    _canvas: null,
    _ctx: null,
    _elements: [],
    _observer: null,
    _resizeTimer: null,
    _svgNS: 'http://www.w3.org/2000/svg',
    _booted: false,
  };

  // ─────────────────── Canvas SDF ───────────────────

  /**
   * 在 Canvas 上绘制圆角矩形的有符号距离场（SDF）。
   * 正值 = 矩形内部，负值 = 矩形外部，0 = 边缘上。
   * 然后映射到 displacement map：边缘附近 → 非中性色，内部 → (128,128) 中性灰。
   */
  function drawRoundedRectSDF(ctx, w, h, r, edgeThresh) {
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const cx = w / 2, cy = h / 2;
    const hw = w / 2, hh = h / 2;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 计算点到圆角矩形边缘的有符号距离
        const dx = Math.abs(x - cx);
        const dy = Math.abs(y - cy);

        // 圆角矩形 SDF：将点映射到圆角矩形内部
        let sd;
        if (dx <= hw - r || dy <= hh - r) {
          // 在矩形主体区域内
          const innerX = Math.max(dx - (hw - r), 0);
          const innerY = Math.max(dy - (hh - r), 0);
          sd = r - Math.sqrt(innerX * innerX + innerY * innerY);
        } else {
          // 在圆角区域或外部
          const cornerX = dx - (hw - r);
          const cornerY = dy - (hh - r);
          sd = r - Math.sqrt(cornerX * cornerX + cornerY * cornerY);
        }

        // 映射 SDF 到 displacement 颜色通道
        // edgeThresh 范围内的边缘区域 → 有位移值
        // 内部（sd > edgeThresh）→ 中性色 128
        // 外部（sd < -edgeThresh）→ 中性色 128
        let intensity;
        if (sd > edgeThresh) {
          // 内部深处 — 无折射
          intensity = 0;
        } else if (sd < -edgeThresh) {
          // 外部远处 — 无折射
          intensity = 0;
        } else {
          // 边缘区域 — 平滑过渡折射
          // 从 -edgeThresh 到 +edgeThresh 做映射
          const t = (sd + edgeThresh) / (2 * edgeThresh); // 0 (外边缘) → 1 (内边缘)
          // 用 sin 曲线做非线性过渡，边缘峰值高
          intensity = Math.sin(t * Math.PI);
        }

        // displacement map: R=G=128 + intensity*127, 中性=128
        const val = 128 + Math.round(intensity * 127);
        const idx = (y * w + x) * 4;
        data[idx] = val;         // R
        data[idx + 1] = val;    // G
        data[idx + 2] = 128;    // B (固定 128，feDisplacementMap 用 R/G 通道)
        data[idx + 3] = 255;    // A
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ─────────────────── Canvas 缓存 ───────────────────

  function getCanvas(w, h) {
    if (!LIQUID_GLASS._canvas) {
      LIQUID_GLASS._canvas = document.createElement('canvas');
      LIQUID_GLASS._ctx = LIQUID_GLASS._canvas.getContext('2d');
    }
    const c = LIQUID_GLASS._canvas;
    const d = LIQUID_GLASS.mapDensity;
    const cw = Math.round(w * d), ch = Math.round(h * d);
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    return c;
  }

  // ─────────────────── 生成单个元素的位移贴图 ───────────────────

  function generateMapForElement(el) {
    const rect = el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w < 10 || h < 10) return null;

    const style = getComputedStyle(el);
    const borderRadius = parseFloat(style.borderRadius) || 28;
    const r = Math.min(borderRadius, w / 2, h / 2);

    const canvas = getCanvas(w, h);
    const ctx = LIQUID_GLASS._ctx;
    drawRoundedRectSDF(ctx, canvas.width, canvas.height, r * LIQUID_GLASS.mapDensity, LIQUID_GLASS.edgeThreshold);
    return canvas.toDataURL('image/png');
  }

  // ─────────────────── 创建 / 更新 SVG 滤镜 ───────────────────

  function ensureRootSVG() {
    // 查找或创建根 SVG（隐藏，挂着所有滤镜）
    let svg = document.getElementById('liquid-glass-root');
    if (svg) return svg;

    svg = document.createElementNS(LIQUID_GLASS._svgNS, 'svg');
    svg.id = 'liquid-glass-root';
    svg.setAttribute('style', 'position:fixed;width:0;height:0;pointer-events:none;top:0;left:0;');
    svg.setAttribute('aria-hidden', 'true');
    document.body.appendChild(svg);
    return svg;
  }

  function ensureFilter(svg, el, dataUrl, w, h) {
    const id = getFilterId(el);
    let filter = document.getElementById(id);

    if (!filter) {
      filter = document.createElementNS(LIQUID_GLASS._svgNS, 'filter');
      filter.id = id;
      filter.setAttribute('x', '0%');
      filter.setAttribute('y', '0%');
      filter.setAttribute('width', '100%');
      filter.setAttribute('height', '100%');
      filter.setAttribute('color-interpolation-filters', 'sRGB');

      // feImage — 位移贴图
      const feImg = document.createElementNS(LIQUID_GLASS._svgNS, 'feImage');
      feImg.setAttribute('id', id + '-map');
      feImg.setAttribute('href', dataUrl);
      feImg.setAttribute('width', w);
      feImg.setAttribute('height', h);
      feImg.setAttribute('result', 'displacement-map');
      filter.appendChild(feImg);

      // feDisplacementMap — 边缘折射
      const feDM = document.createElementNS(LIQUID_GLASS._svgNS, 'feDisplacementMap');
      feDM.setAttribute('in', 'SourceGraphic');
      feDM.setAttribute('in2', 'displacement-map');
      feDM.setAttribute('scale', LIQUID_GLASS.refractionScale);
      feDM.setAttribute('xChannelSelector', 'R');
      feDM.setAttribute('yChannelSelector', 'G');
      feDM.setAttribute('result', 'refracted');
      filter.appendChild(feDM);

      svg.appendChild(filter);
    } else {
      // 更新 feImage 的 href
      const feImg = document.getElementById(id + '-map');
      if (feImg) {
        feImg.setAttribute('href', dataUrl);
      }
    }
    return filter.id;
  }

  function getFilterId(el) {
    if (el.id) return 'lg-' + el.id;
    // 给元素一个自动 ID
    let autoId = el.getAttribute('data-glass-id');
    if (!autoId) {
      autoId = 'lg-' + Math.random().toString(36).slice(2, 8);
      el.setAttribute('data-glass-id', autoId);
    }
    return autoId;
  }

  // ─────────────────── 应用 CSS ───────────────────

  function applyGlassCSS(el, filterId) {
    // 确保元素有液态玻璃基础样式（不覆盖已有的）
    if (!el.style.backdropFilter && !getComputedStyle(el).backdropFilter) {
      el.style.backdropFilter = `url(#${filterId}) blur(2px) saturate(1.8) contrast(1.02) brightness(1.05)`;
      el.style.webkitBackdropFilter = `url(#${filterId}) blur(2px) saturate(1.8) contrast(1.02) brightness(1.05)`;
    }

    // 菲涅尔边缘高光（不覆盖已有的非 none boxShadow）
    const existingBoxShadow = getComputedStyle(el).boxShadow;
    if (!el.style.boxShadow && (existingBoxShadow === 'none' || !existingBoxShadow)) {
      el.style.boxShadow = [
        'inset 0 1px 1px rgba(255,255,255,0.35)',
        'inset 0 -1px 1px rgba(255,255,255,0.08)',
        '0 10px 40px rgba(0,0,0,0.3)',
      ].join(', ');
    }

    // 确保元素有 relative/absolute/fixed 定位以承载 ::after 高光
    const pos = getComputedStyle(el).position;
    if (pos === 'static') {
      el.style.position = 'relative';
    }
    el.style.overflow = 'hidden';
  }

  // ─────────────────── 鼠标跟随高光 ───────────────────

  function setupHighlight(el) {
    // 通过 CSS 自定义属性驱动 ::after 的 radial-gradient 位置
    const onMove = (e) => {
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width * 100).toFixed(1);
      const y = ((e.clientY - rect.top) / rect.height * 100).toFixed(1);
      el.style.setProperty('--glass-hx', x + '%');
      el.style.setProperty('--glass-hy', y + '%');
      el.style.setProperty('--glass-ha', '0.45');
    };
    const onLeave = () => {
      el.style.setProperty('--glass-hx', '50%');
      el.style.setProperty('--glass-hy', '50%');
      el.style.setProperty('--glass-ha', '0');
    };

    // 避免重复绑定
    if (el._glassHighlightBound) return;
    el._glassHighlightBound = true;
    el.addEventListener('mousemove', onMove, { passive: true });
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      const rect = el.getBoundingClientRect();
      const x = ((t.clientX - rect.left) / rect.width * 100).toFixed(1);
      const y = ((t.clientY - rect.top) / rect.height * 100).toFixed(1);
      el.style.setProperty('--glass-hx', x + '%');
      el.style.setProperty('--glass-hy', y + '%');
      el.style.setProperty('--glass-ha', '0.45');
    }, { passive: true });
    el.addEventListener('touchend', onLeave);
  }

  function injectGlobalGlassCSS() {
    if (document.getElementById('liquid-glass-css')) return;
    const style = document.createElement('style');
    style.id = 'liquid-glass-css';
    style.textContent = `
      /* ——— Liquid Glass 全局样式 ——— */
      [data-glass]::after,
      [data-glass].glass::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
        opacity: var(--glass-ha, 0);
        transition: opacity ${LIQUID_GLASS.highlightTransition};
        background: radial-gradient(
          circle 120px at var(--glass-hx, 50%) var(--glass-hy, 50%),
          rgba(255, 255, 255, 0.35),
          rgba(255, 255, 255, 0.08) 30%,
          transparent 70%
        );
        z-index: 1;
      }

      /* 边缘渐变高光环（叠加在 filter 之上） */
      [data-glass]::before,
      [data-glass].glass::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
        z-index: 0;
        /* mask 做内缩边框：用 mask-composite exclude 只画边缘 */
        -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        -webkit-mask-composite: xor;
        mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
        mask-composite: exclude;
        padding: 1px;
        background: linear-gradient(
          135deg,
          rgba(255, 255, 255, 0.45),
          rgba(255, 255, 255, 0.1) 50%,
          rgba(255, 255, 255, 0.25) 100%
        );
      }
    `;
    document.head.appendChild(style);
  }

  // ─────────────────── 主入口 ───────────────────

  function processElement(el) {
    const dataUrl = generateMapForElement(el);
    if (!dataUrl) return;

    const rect = el.getBoundingClientRect();
    const svg = ensureRootSVG();
    const filterId = ensureFilter(svg, el, dataUrl, rect.width, rect.height);

    applyGlassCSS(el, filterId);
    setupHighlight(el);

    // 给元素加 data-glass 属性以触发 ::before/::after 伪元素
    if (!el.hasAttribute('data-glass')) {
      el.setAttribute('data-glass', '');
    }
  }

  function scanElements(root = document) {
    const els = root.querySelectorAll('.glass, [data-glass], [class*="glass-card"], [class*="glass-btn"], [class*="glass-panel"], [class*="glass-nav"]');
    els.forEach(processElement);
  }

  function setupObserver() {
    if (LIQUID_GLASS._observer) return;
    // 尺寸变化时重新生成贴图
    LIQUID_GLASS._observer = new ResizeObserver((entries) => {
      clearTimeout(LIQUID_GLASS._resizeTimer);
      LIQUID_GLASS._resizeTimer = setTimeout(() => {
        entries.forEach((entry) => {
          const el = entry.target;
          if (el.hasAttribute('data-glass') || el.classList.contains('glass')) {
            processElement(el);
          }
        });
      }, LIQUID_GLASS.resizeDebounce);
    });
  }

  function observeElement(el) {
    if (LIQUID_GLASS._observer) {
      LIQUID_GLASS._observer.observe(el);
    }
  }

  /**
   * 启动液态玻璃效果
   * @param {object} opts - 可选配置
   * @param {number} opts.edgeThreshold - 边缘阈值 (默认 40)
   * @param {number} opts.refractionScale - 折射强度 (默认 25)
   * @param {number} opts.mapDensity - 贴图密度 (默认 1.0)
   */
  function boot(opts = {}) {
    if (opts.edgeThreshold !== undefined) LIQUID_GLASS.edgeThreshold = opts.edgeThreshold;
    if (opts.refractionScale !== undefined) LIQUID_GLASS.refractionScale = opts.refractionScale;
    if (opts.mapDensity !== undefined) LIQUID_GLASS.mapDensity = opts.mapDensity;

    if (LIQUID_GLASS._booted) return;
    LIQUID_GLASS._booted = true;

    injectGlobalGlassCSS();
    setupObserver();
    scanElements();

    // 等待布局稳定后再扫描一轮（处理初始渲染）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scanElements());
    });

    // 窗口 resize 全局刷新
    window.addEventListener('resize', () => {
      clearTimeout(LIQUID_GLASS._resizeTimer);
      LIQUID_GLASS._resizeTimer = setTimeout(() => scanElements(), LIQUID_GLASS.resizeDebounce);
    });
  }

  /**
   * 刷新所有玻璃元素（内容变化后调用）
   */
  function refresh() {
    scanElements();
  }

  /**
   * 给单个元素添加液态玻璃效果
   */
  function glassify(el) {
    el.setAttribute('data-glass', '');
    processElement(el);
    observeElement(el);
  }

  // ─────────────────── 暴露 API ───────────────────

  window.LiquidGlass = {
    boot,
    refresh,
    glassify,
    scanElements,
    generateMapForElement,
    processElement,
    config: LIQUID_GLASS,
  };
})();