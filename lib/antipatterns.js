/**
 * AntipatternDetector —— Werkstatt AI 编辑器的确定性反模式检测器
 * ============================================================================
 *
 * 模块用途：
 *   为 Werkstatt Agent 模式的 run_code_check 工具提供确定性反模式检测能力。
 *   核心创新是"检测→教学绑定"：检测到反模式时不仅报告问题，还附带设计教导
 *   （skillGuideline），把 linter 变成教练——告诉 AI/用户违反了哪条设计原则、
 *   应该如何修正，从而在迭代中持续改进设计品味。
 *
 * 借鉴来源：Impeccable 项目（A+ 评级）的确定性反模式检测器。从其 44 条规则中
 *   精选 15 条最适用于前端 UI 代码生成的规则，覆盖三个严重级别：
 *     - slop（AI 味特征，9 条）：AI 生成界面的典型劣习指纹
 *     - quality（通用质量问题，4 条）：对比度、间距、字号等基础质量
 *     - always-avoid（质量底线，2 条）：不可妥协的质量失败
 *
 * 设计原则：
 *   - 纯 JavaScript，无外部依赖，确定性检测（正则/字符串匹配，不依赖 LLM）
 *   - 每条规则独立函数，便于维护与扩展
 *   - 所有 issue 携带 skillGuideline 字段，说明违反的设计原则与正确做法
 *
 * 运行环境：浏览器端（非 Node.js）。
 *
 * 挂载点：window.AntipatternDetector
 *   - detect(code, lang)   : 检测代码，返回 issues 数组
 *   - rules                : RULE_DEFINITIONS 规则元数据数组（供 UI 展示）
 *   - format(issues)       : 格式化 issues 为可读字符串（供 Agent 工具返回）
 * ============================================================================
 */
(function (global) {
    'use strict';

    // ============================================================
    // 工具函数
    // ============================================================

    /** 根据字符索引计算所在行号（1-based） */
    function lineOf(code, index) {
        if (!code || index <= 0) return 1;
        var prefix = code.substring(0, index);
        return prefix.split('\n').length;
    }

    /** 从 HTML 中提取所有 <style> 块内容 + inline style 属性值，便于对内联 CSS 应用 CSS 规则 */
    function extractStyleFromHtml(code) {
        var parts = [];
        var re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
        var m;
        while ((m = re.exec(code)) !== null) {
            parts.push(m[1]);
        }
        // 收集 inline style 属性值
        var styleAttrRe = /style\s*=\s*["']([^"']+)["']/gi;
        while ((m = styleAttrRe.exec(code)) !== null) {
            parts.push(m[1]);
        }
        return parts.join('\n');
    }

    /** 从 HTML 中提取可见文本内容（去标签、去 script/style、压缩空白） */
    function extractTextFromHtml(code) {
        return code
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&[a-z]+;/gi, ' ')
            .replace(/\s+/g, ' ');
    }

    /** 简易亮度计算（0-255），用于对比度估算 */
    function luminance(hex) {
        if (!hex) return null;
        var m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
        if (!m) return null;
        var h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var r = parseInt(h.substring(0, 2), 16);
        var g = parseInt(h.substring(2, 4), 16);
        var b = parseInt(h.substring(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b);
    }

    /** 判断 hex 是否为灰色（R/G/B 三通道接近） */
    function isGrayHex(hex) {
        var m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex || '').trim());
        if (!m) return false;
        var h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var r = parseInt(h.substring(0, 2), 16);
        var g = parseInt(h.substring(2, 4), 16);
        var b = parseInt(h.substring(4, 6), 16);
        return Math.max(r, g, b) - Math.min(r, g, b) <= 18;
    }

    // ============================================================
    // 规则元数据（供 UI 展示）
    // ============================================================

    var RULE_DEFINITIONS = [
        // --- slop 级（AI 味特征）9 条 ---
        {
            id: 'overused-font', name: 'AI 泛滥字体', severity: 'slop',
            description: '检测 Inter/Roboto/Arial 等作为主字体',
            guideline: 'Inter/Roboto/Arial 是AI最泛滥的默认字体，立即产生"AI味"。改用 Geist/Satoshi/Outfit/Cabinet Grotesk 或设计系统指定字体'
        },
        {
            id: 'ai-color-palette', name: '紫蓝渐变配色', severity: 'slop',
            description: '检测 purple/violet/indigo→blue 渐变组合',
            guideline: '紫蓝渐变是AI配色的头号指纹。改用单一强调色+中性基底，或品牌指定色板'
        },
        {
            id: 'gradient-text', name: '渐变文字', severity: 'slop',
            description: '检测 background-clip:text + 渐变',
            guideline: '渐变文字是装饰性非语义用法，AI常用来做"高级感"。改用字重/字号/颜色建立层级'
        },
        {
            id: 'nested-cards', name: '卡片嵌套', severity: 'slop',
            description: '检测 .card 内嵌 .card 或阴影元素嵌阴影元素',
            guideline: '卡片嵌套卡片造成视觉混乱。用间距和分隔线代替嵌套'
        },
        {
            id: 'em-dash-overuse', name: 'em-dash 泛滥', severity: 'slop',
            description: '检测正文超过 2 个 em-dash（—）',
            guideline: 'em-dash泛滥是AI文案节奏指纹。改用短横线或重构语句'
        },
        {
            id: 'icon-tile-stack', name: '圆角方块图标容器', severity: 'slop',
            description: '检测标题上方圆角方块图标容器',
            guideline: '圆角方块图标容器是通用AI特性卡模板。改用inline图标或去除容器'
        },
        {
            id: 'hero-eyebrow-chip', name: 'Hero 眉标', severity: 'slop',
            description: '检测 H1 正上方的小型大写字距标签/pill',
            guideline: 'Hero眉标是AI默认模板。直接用标题承载意义'
        },
        {
            id: 'bounce-easing', name: 'bounce/elastic 缓动', severity: 'slop',
            description: '检测 bounce/elastic 缓动或超范围 cubic-bezier',
            guideline: 'bounce/elastic缓动过时俗气。用 ease-out/expo-out 等克制缓动'
        },
        {
            id: 'cream-palette', name: '奶油色底色', severity: 'slop',
            description: '检测奶油/米色页面背景',
            guideline: '奶油色是2026年AI"安全有品味"的默认底色。除非品牌明确需要，改用纯白或品牌指定色'
        },
        // --- quality 级（通用质量问题）4 条 ---
        {
            id: 'low-contrast', name: '低对比度文字', severity: 'quality',
            description: '检测文字与背景颜色接近导致对比度不足',
            guideline: '对比度不足违反WCAG AA标准。文字与背景亮度差应≥4.5:1'
        },
        {
            id: 'gray-on-color', name: '彩色背景灰文字', severity: 'quality',
            description: '检测彩色背景上的灰色文字',
            guideline: '彩色背景上的灰色文字对比度不足。彩色背景应用白色或深色文字'
        },
        {
            id: 'monotonous-spacing', name: '间距无节奏', severity: 'quality',
            description: '检测处处同一间距值',
            guideline: '间距无节奏感。section间距应64-96px，卡片内24-32px，元素间8-16px，形成节奏'
        },
        {
            id: 'oversized-h1', name: '长句标题用 display 字号', severity: 'quality',
            description: '检测 h1 文字超过 40 字符且 font-size>40px',
            guideline: '长句标题用display字号会变成6行标题墙。用宽容器(max-w-5xl+)控制2-3行'
        },
        // --- always-avoid 级（质量底线）2 条 ---
        {
            id: 'prompt-language-leak', name: 'prompt 语言泄漏', severity: 'always-avoid',
            description: '检测 UI 文案含 prompt 语言（Experience the/Unlock your/Seamless 等）',
            guideline: 'prompt语言泄漏到UI是质量失败。文案应像产品语言，不像营销空话'
        },
        {
            id: 'div-soup', name: 'div 堆砌', severity: 'always-avoid',
            description: '检测连续 div 嵌套超 3 层且无 class/role',
            guideline: '有合适HTML元素却用div堆砌是质量底线。用nav/main/section/article/button等语义元素'
        }
    ];

    // 规则 ID -> guideline 快速映射
    var GUIDELINE_MAP = {};
    RULE_DEFINITIONS.forEach(function (r) { GUIDELINE_MAP[r.id] = r.guideline; });

    // ============================================================
    // 各规则检测函数
    // 每个函数返回 issues 数组（可能为空）
    // ============================================================

    /** 1. overused-font —— 检测 Inter/Roboto/Arial 等作为主字体 */
    function ruleOverusedFont(code) {
        var issues = [];
        // 捕获组需兼容带引号的字体名（"Inter"/'Roboto'），用交替分支吞下完整引号串
        var re = /font-family\s*:\s*((?:[^;}"']|"[^"]*"|'[^']*')+)/gi;
        var overused = /\b(Inter|Roboto|Arial|Helvetica(?:\s+Neue)?|Open\s+Sans|Lato|Montserrat|Poppins)\b/i;
        var m;
        while ((m = re.exec(code)) !== null) {
            if (overused.test(m[1])) {
                issues.push({
                    id: 'overused-font',
                    severity: 'slop',
                    title: '使用了 AI 泛滥的默认字体',
                    detail: 'font-family: ' + m[1].trim() + ' 含 Inter/Roboto/Arial 等过度使用字体',
                    guideline: GUIDELINE_MAP['overused-font'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        return issues;
    }

    /** 2. ai-color-palette —— 检测紫蓝渐变（purple/violet/indigo→blue） */
    function ruleAiColorPalette(code) {
        var issues = [];
        // 紫色系 hex（indigo/violet/purple/fuchsia）
        var purples = /#?(6366f1|8b5cf6|7c3aed|a855f7|9333ea|6d28d9|4f46e5|5b21b6|c084fc|d8b4fe|818cf8|a78bfa)/i;
        // 蓝色系 hex（blue/sky/cyan）
        var blues = /#?(3b82f6|2563eb|1d4ed8|1e40af|0ea5e9|0284c7|0369a1|60a5fa|38bdf8|22d3ee)/i;
        var re = /(?:linear|radial|conic)-gradient\s*\([^)]+\)/gi;
        var m;
        while ((m = re.exec(code)) !== null) {
            if (purples.test(m[0]) && blues.test(m[0])) {
                issues.push({
                    id: 'ai-color-palette',
                    severity: 'slop',
                    title: '检测到紫蓝渐变（AI 配色头号指纹）',
                    detail: '渐变同时包含紫色系与蓝色系：' + m[0].substring(0, 80),
                    guideline: GUIDELINE_MAP['ai-color-palette'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        return issues;
    }

    /** 3. gradient-text —— 检测 background-clip:text + 渐变 */
    function ruleGradientText(code) {
        var issues = [];
        var re = /background-clip\s*:\s*(?:-webkit-)?text\b/gi;
        var m;
        while ((m = re.exec(code)) !== null) {
            // 在前后 300 字符内查找 gradient，判断是否配合渐变使用
            var around = code.substring(Math.max(0, m.index - 300), Math.min(code.length, m.index + 300));
            if (/(?:linear|radial|conic)-gradient\s*\(/i.test(around)) {
                issues.push({
                    id: 'gradient-text',
                    severity: 'slop',
                    title: '渐变文字（background-clip:text + gradient）',
                    detail: '使用 background-clip:text 配合渐变做装饰性文字',
                    guideline: GUIDELINE_MAP['gradient-text'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        return issues;
    }

    /** 4. nested-cards —— 检测 .card 内嵌 .card */
    function ruleNestedCards(code) {
        var issues = [];
        var openRe = /<\w+[^>]*class\s*=\s*["'][^"']*\bcard\b[^"']*["'][^>]*>/gi;
        // 内层用非全局正则做存在性判断，避免 lastIndex 干扰
        var innerRe = /<\w+[^>]*class\s*=\s*["'][^"']*\bcard\b[^"']*["'][^>]*>/i;
        var m;
        while ((m = openRe.exec(code)) !== null) {
            var after = code.substring(m.index + m[0].length, m.index + m[0].length + 800);
            if (innerRe.test(after)) {
                issues.push({
                    id: 'nested-cards',
                    severity: 'slop',
                    title: '卡片嵌套卡片',
                    detail: '检测到 .card 元素内部又嵌套 .card 元素，造成视觉混乱',
                    guideline: GUIDELINE_MAP['nested-cards'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        return issues;
    }

    /** 5. em-dash-overuse —— 检测正文超过 2 个 em-dash（—） */
    function ruleEmDashOveruse(code, lang) {
        var issues = [];
        var text = lang === 'html' ? extractTextFromHtml(code) : code;
        var count = (text.match(/—/g) || []).length;
        if (count > 2) {
            issues.push({
                id: 'em-dash-overuse',
                severity: 'slop',
                title: 'em-dash（—）泛滥',
                detail: '正文/文案中出现 ' + count + ' 个 em-dash，AI 文案节奏指纹',
                guideline: GUIDELINE_MAP['em-dash-overuse'],
                location: '全文'
            });
        }
        return issues;
    }

    /** 6. icon-tile-stack —— 检测标题上方圆角方块图标容器 */
    function ruleIconTileStack(code) {
        var issues = [];
        // 检测 class 含 icon + (container/box/tile/wrapper/holder) 的元素
        var re = /<\w+[^>]*class\s*=\s*["'][^"']*\bicon\b[^"']*(?:container|box|tile|wrapper|holder|badge)[^"']*["'][^>]*>/gi;
        var m;
        while ((m = re.exec(code)) !== null) {
            issues.push({
                id: 'icon-tile-stack',
                severity: 'slop',
                title: '圆角方块图标容器（AI 特性卡模板）',
                detail: '检测到图标容器元素：' + m[0].substring(0, 80),
                guideline: GUIDELINE_MAP['icon-tile-stack'],
                location: '第 ' + lineOf(code, m.index) + ' 行'
            });
        }
        // 补充：检测 inline style 中固定尺寸 + border-radius + background 的图标容器
        var inlineRe = /style\s*=\s*["'][^"']*(?:width\s*:\s*\d+px)[^"']*(?:height\s*:\s*\d+px)[^"']*(?:border-radius)[^"']*(?:background)[^"']*["']/gi;
        while ((m = inlineRe.exec(code)) !== null) {
            // 仅当附近有 icon/feature 字样时报告，避免误报普通色块
            var around = code.substring(Math.max(0, m.index - 200), m.index + 200);
            if (/icon|feature/i.test(around)) {
                issues.push({
                    id: 'icon-tile-stack',
                    severity: 'slop',
                    title: '圆角方块图标容器（AI 特性卡模板）',
                    detail: '检测到固定尺寸+圆角+背景色的图标容器 inline 样式',
                    guideline: GUIDELINE_MAP['icon-tile-stack'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        return issues;
    }

    /** 7. hero-eyebrow-chip —— 检测 H1 正上方的小型大写字距标签/pill */
    function ruleHeroEyebrowChip(code) {
        var issues = [];
        var h1Re = /<h1\b[^>]*>/gi;
        var m;
        while ((m = h1Re.exec(code)) !== null) {
            var before = code.substring(Math.max(0, m.index - 250), m.index);
            // 检测 eyebrow/badge/pill/chip/kicker/overline 类元素，或 uppercase+letter-spacing 样式
            var eyebrowRe = /class\s*=\s*["'][^"']*\b(eyebrow|badge|pill|chip|kicker|overline|tag|eyebrow-text|section-label)\b[^"']*["']/i;
            var upperRe = /text-transform\s*:\s*uppercase[^}]*letter-spacing/i;
            if (eyebrowRe.test(before) || upperRe.test(before)) {
                issues.push({
                    id: 'hero-eyebrow-chip',
                    severity: 'slop',
                    title: 'Hero 眉标（H1 上方的小型大写字距标签）',
                    detail: '检测到 H1 正上方存在 eyebrow/badge/pill 等眉标元素',
                    guideline: GUIDELINE_MAP['hero-eyebrow-chip'],
                    location: '第 ' + lineOf(code, m.index) + ' 行（H1 上方）'
                });
            }
        }
        return issues;
    }

    /** 8. bounce-easing —— 检测 bounce/elastic 缓动或超范围 cubic-bezier */
    function ruleBounceEasing(code, lang) {
        var issues = [];
        // 检测 cubic-bezier 中存在 >1 或 <0 的超范围值（bounce/elastic 特征）
        var cbRe = /cubic-bezier\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gi;
        var m;
        while ((m = cbRe.exec(code)) !== null) {
            var vals = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
            if (vals.some(function (v) { return v > 1 || v < 0; })) {
                issues.push({
                    id: 'bounce-easing',
                    severity: 'slop',
                    title: 'bounce/elastic 缓动（超范围 cubic-bezier）',
                    detail: 'cubic-bezier 含超范围值（' + vals.join(', ') + '），属于 bounce/elastic 缓动',
                    guideline: GUIDELINE_MAP['bounce-easing'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        // 检测 animation/transition-timing-function 直接使用 bounce/elastic/back
        var nameRe = /(?:animation-timing-function|transition-timing-function|easing)\s*:\s*(bounce|elastic|ease-in-bounce|ease-out-bounce|ease-in-elastic|ease-out-elastic|easeInOutBack|ease-out-back)/gi;
        while ((m = nameRe.exec(code)) !== null) {
            issues.push({
                id: 'bounce-easing',
                severity: 'slop',
                title: 'bounce/elastic 缓动',
                detail: '使用 ' + m[1] + ' 缓动，过时俗气',
                guideline: GUIDELINE_MAP['bounce-easing'],
                location: '第 ' + lineOf(code, m.index) + ' 行'
            });
        }
        // JS 中 GSAP/CSS-in-JS bounce/elastic/back 缓动（兼容 ease.bounce / ease:"elastic" / ease="back" 等）
        if (lang === 'javascript' || lang === 'html') {
            var jsRe = /\bease\s*[:.=\[]?\s*["']?\s*(?:bounce|elastic|back)/gi;
            while ((m = jsRe.exec(code)) !== null) {
                issues.push({
                    id: 'bounce-easing',
                    severity: 'slop',
                    title: 'bounce/elastic 缓动（JS 动画）',
                    detail: 'JS 动画使用 bounce/elastic/back 缓动',
                    guideline: GUIDELINE_MAP['bounce-easing'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        return issues;
    }

    /** 9. cream-palette —— 检测奶油/米色页面背景 */
    function ruleCreamPalette(code, lang) {
        var issues = [];
        var creamColors = /#?(faf9f5|f5e9d4|faf0e6|fdf6e3|f8f5f0|f5f0e8|faf8f3|f7f3ec|fefcf3|f5efe0|f4ecd8|faf5ef|f7f2e9|fbf6ee|f5f1e8|faf6ef)/i;
        var bgRe = /background(?:-color)?\s*:\s*(#[0-9a-f]{3,6}|[a-z]+)/gi;
        var m;
        while ((m = bgRe.exec(code)) !== null) {
            if (creamColors.test(m[1])) {
                // 判断是否作用于 body/html/:root（页面级底色）；CSS 模式默认视为页面级
                var around = code.substring(Math.max(0, m.index - 200), m.index + 50);
                if (lang === 'css' || /body|html|:root|\*/i.test(around)) {
                    issues.push({
                        id: 'cream-palette',
                        severity: 'slop',
                        title: '奶油/米色页面背景',
                        detail: '页面背景使用奶油色 ' + m[1] + '，AI"安全有品味"的默认底色',
                        guideline: GUIDELINE_MAP['cream-palette'],
                        location: '第 ' + lineOf(code, m.index) + ' 行'
                    });
                }
            }
        }
        return issues;
    }

    /** 10. low-contrast —— 检测低对比度文字（简易：浅灰文字） */
    function ruleLowContrast(code) {
        var issues = [];
        // 检测浅灰文字色（#ccc/#ddd/#eee/#bbb/#999 等），亮度过高在浅色背景上对比度不足
        var lightGrayRe = /(?:^|[^-])\bcolor\s*:\s*(#(?:ccc|ddd|eee|bbb|999|d3d3d3|e5e7eb|d1d5db|9ca3af|a1a1aa|cbd5e1|e2e8f0))\b/gi;
        var m;
        while ((m = lightGrayRe.exec(code)) !== null) {
            var lum = luminance(m[1]);
            if (lum !== null && lum > 180) {
                issues.push({
                    id: 'low-contrast',
                    severity: 'quality',
                    title: '低对比度文字',
                    detail: '文字颜色 ' + m[1] + ' 亮度过高，在浅色背景上对比度不足',
                    guideline: GUIDELINE_MAP['low-contrast'],
                    location: '第 ' + lineOf(code, m.index) + ' 行'
                });
            }
        }
        return issues;
    }

    /** 11. gray-on-color —— 检测彩色背景上的灰色文字 */
    function ruleGrayOnColor(code) {
        var issues = [];
        // 按 CSS 规则块切分（宽松大括号配对），块内 background 为彩色且 color 为灰色
        var blockRe = /([^{}]*?)\{([^{}]*)\}/g;
        var m;
        while ((m = blockRe.exec(code)) !== null) {
            var selector = m[1];
            var body = m[2];
            // 用单次正则同时匹配 background-color 与 color，区分两者
            var bgMatch = null, colorMatch = null;
            var declRe = /((?:background-)?color)\s*:\s*(#[0-9a-f]{3,6}|[a-z]+)/gi;
            var dm;
            while ((dm = declRe.exec(body)) !== null) {
                if (dm[1].toLowerCase() === 'background-color' || dm[1].toLowerCase() === 'background') {
                    bgMatch = dm[2];
                } else {
                    colorMatch = dm[2];
                }
            }
            if (bgMatch && colorMatch) {
                var bgIsGray = isGrayHex(bgMatch);
                var textIsGray = isGrayHex(colorMatch);
                if (!bgIsGray && textIsGray) {
                    var sel = selector.trim().substring(0, 40);
                    issues.push({
                        id: 'gray-on-color',
                        severity: 'quality',
                        title: '彩色背景上的灰色文字',
                        detail: '选择器 ' + sel + '：背景 ' + bgMatch + '（彩色）+ 文字 ' + colorMatch + '（灰色），对比度不足',
                        guideline: GUIDELINE_MAP['gray-on-color'],
                        location: '选择器: ' + sel
                    });
                }
            }
        }
        return issues;
    }

    /** 12. monotonous-spacing —— 检测处处同一间距值 */
    function ruleMonotonousSpacing(code) {
        var issues = [];
        // 统计各 padding/margin 像素值出现次数，若单一值占比 ≥60% 且总数 ≥6 则报告
        var re = /(?:padding|margin)\s*:\s*(\d+px)\b/gi;
        var counts = {};
        var total = 0;
        var m;
        while ((m = re.exec(code)) !== null) {
            counts[m[1]] = (counts[m[1]] || 0) + 1;
            total++;
        }
        if (total >= 6) {
            var maxVal = null, maxCount = 0;
            for (var v in counts) {
                if (counts[v] > maxCount) { maxCount = counts[v]; maxVal = v; }
            }
            if (maxCount / total >= 0.6) {
                issues.push({
                    id: 'monotonous-spacing',
                    severity: 'quality',
                    title: '间距无节奏（处处同一值）',
                    detail: '共 ' + total + ' 处 padding/margin，其中 ' + maxCount + ' 处使用 ' + maxVal + '（占比 ' + Math.round(maxCount / total * 100) + '%），缺乏节奏',
                    guideline: GUIDELINE_MAP['monotonous-spacing'],
                    location: '全文'
                });
            }
        }
        return issues;
    }

    /** 13. oversized-h1 —— 检测长句标题用 display 字号 */
    function ruleOversizedH1(code) {
        var issues = [];
        var h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;
        var m;
        while ((m = h1Re.exec(code)) !== null) {
            var text = m[1].replace(/<[^>]+>/g, '').trim();
            if (text.length > 40) {
                // 检测 font-size > 40px（inline style 或全文 h1 CSS 规则）
                var tag = m[0].substring(0, m[0].indexOf('>'));
                var bigFont = false;
                var inlineFs = /font-size\s*:\s*(\d+)px/i.exec(tag);
                if (inlineFs && parseInt(inlineFs[1], 10) > 40) bigFont = true;
                if (!bigFont) {
                    var cssFs = /h1\s*\{[^}]*font-size\s*:\s*(\d+)px/i.exec(code);
                    if (cssFs && parseInt(cssFs[1], 10) > 40) bigFont = true;
                }
                if (bigFont) {
                    issues.push({
                        id: 'oversized-h1',
                        severity: 'quality',
                        title: '长句标题用 display 字号（标题墙风险）',
                        detail: 'H1 文案 ' + text.length + ' 字符（>40）且 font-size > 40px，易变成 6 行标题墙',
                        guideline: GUIDELINE_MAP['oversized-h1'],
                        location: '第 ' + lineOf(code, m.index) + ' 行'
                    });
                }
            }
        }
        return issues;
    }

    /** 14. prompt-language-leak —— 检测 UI 文案含 prompt 语言 */
    function rulePromptLanguageLeak(code, lang) {
        var issues = [];
        var text = lang === 'html' ? extractTextFromHtml(code) : code;
        // AI 营销空话黑名单
        var phrases = [
            'Experience the', 'Unlock your', 'Seamless integration', 'Seamlessly',
            'Leverage', 'Empower', 'Streamline', 'Cutting-edge', 'Revolutionary',
            'Game-changing', 'Next-generation', 'Transform your', 'Supercharge',
            'Elevate your', 'Robust', 'Innovative', 'Powerful', 'Best-in-class',
            'World-class', 'Reimagined', 'Reinvent', 'Disrupt', 'Synergy',
            'Holistic', 'Paradigm', 'Pioneering', 'State-of-the-art'
        ];
        var seen = {};
        phrases.forEach(function (p) {
            // 构建大小写不敏感的单词边界正则
            var pattern = '\\b' + p.replace(/[a-zA-Z]/g, function (c) {
                return '[' + c.toLowerCase() + c.toUpperCase() + ']';
            }).replace(/-/g, '\\-') + '\\b';
            var re = new RegExp(pattern, 'g');
            if (re.test(text) && !seen[p]) {
                seen[p] = true;
                issues.push({
                    id: 'prompt-language-leak',
                    severity: 'always-avoid',
                    title: 'prompt 语言泄漏到 UI',
                    detail: '文案含营销空话"' + p + '"，像 prompt 不像产品语言',
                    guideline: GUIDELINE_MAP['prompt-language-leak'],
                    location: '全文文案'
                });
            }
        });
        return issues;
    }

    /** 15. div-soup —— 检测连续 div 嵌套超 3 层且无 class/role */
    function ruleDivSoup(code) {
        var issues = [];
        // 用栈扫描标签，统计连续无语义 div 的最大嵌套深度
        var tagRe = /<(\/?)\s*(\w+)([^>]*)>/g;
        var stack = [];
        var m;
        var maxDepth = 0;
        var maxDepthLoc = 0;
        var voidTags = /^(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)$/i;
        while ((m = tagRe.exec(code)) !== null) {
            var closing = m[1] === '/';
            var name = m[2].toLowerCase();
            var attrs = m[3] || '';
            if (closing) {
                // 弹栈到最近的同名开标签（容忍未闭合标签）
                for (var i = stack.length - 1; i >= 0; i--) {
                    if (stack[i].name === name) { stack.splice(i); break; }
                }
                continue;
            }
            // 自闭合或 void 元素跳过
            if (/\/$/.test(attrs) || voidTags.test(name)) continue;
            var hasSemantic = /\b(class|role|id|aria-)\s*=/.test(attrs) || name !== 'div';
            stack.push({ name: name, hasSemantic: hasSemantic, index: m.index });
            // 统计栈顶连续无语义 div 的深度
            var divRun = 0;
            for (var j = stack.length - 1; j >= 0; j--) {
                if (stack[j].name === 'div' && !stack[j].hasSemantic) divRun++;
                else break;
            }
            if (divRun > maxDepth) { maxDepth = divRun; maxDepthLoc = m.index; }
        }
        if (maxDepth > 3) {
            issues.push({
                id: 'div-soup',
                severity: 'always-avoid',
                title: 'div 堆砌（连续嵌套 ' + maxDepth + ' 层无 class/role）',
                detail: '检测到连续 ' + maxDepth + ' 层 div 嵌套且无 class/role，本应用 nav/main/section/article 等语义元素',
                guideline: GUIDELINE_MAP['div-soup'],
                location: '第 ' + lineOf(code, maxDepthLoc) + ' 行附近'
            });
        }
        return issues;
    }

    // ============================================================
    // 主检测函数
    // ============================================================

    /**
     * 检测代码中的反模式
     * @param {string} code 代码字符串
     * @param {string} lang 语言类型 'html'/'javascript'/'css'
     * @returns {Array} issues 数组，每个 issue 含 id/severity/title/detail/guideline/location
     */
    function detectAntipatterns(code, lang) {
        if (!code || typeof code !== 'string') return [];
        lang = (lang || '').toLowerCase();
        var issues = [];

        if (lang === 'html') {
            // 提取内联 <style> 块 + inline style，对 CSS 规则双跑（原文 + 提取的 CSS）
            var cssPart = extractStyleFromHtml(code);

            // HTML 结构规则
            issues = issues.concat(ruleNestedCards(code));
            issues = issues.concat(ruleIconTileStack(code));
            issues = issues.concat(ruleHeroEyebrowChip(code));
            issues = issues.concat(ruleOversizedH1(code));
            issues = issues.concat(ruleDivSoup(code));
            // 文案规则（基于全文文本）
            issues = issues.concat(ruleEmDashOveruse(code, 'html'));
            issues = issues.concat(rulePromptLanguageLeak(code, 'html'));
            // CSS 规则（原文覆盖 inline style，cssPart 覆盖 <style> 块）
            issues = issues.concat(ruleOverusedFont(code));
            issues = issues.concat(ruleOverusedFont(cssPart));
            issues = issues.concat(ruleAiColorPalette(code));
            issues = issues.concat(ruleAiColorPalette(cssPart));
            issues = issues.concat(ruleGradientText(code));
            issues = issues.concat(ruleGradientText(cssPart));
            issues = issues.concat(ruleBounceEasing(code, 'html'));
            issues = issues.concat(ruleCreamPalette(code, 'html'));
            issues = issues.concat(ruleCreamPalette(cssPart, 'css'));
            issues = issues.concat(ruleLowContrast(code));
            issues = issues.concat(ruleLowContrast(cssPart));
            issues = issues.concat(ruleGrayOnColor(cssPart));
            issues = issues.concat(ruleMonotonousSpacing(code));
            issues = issues.concat(ruleMonotonousSpacing(cssPart));
        } else if (lang === 'css') {
            issues = issues.concat(ruleOverusedFont(code));
            issues = issues.concat(ruleAiColorPalette(code));
            issues = issues.concat(ruleGradientText(code));
            issues = issues.concat(ruleBounceEasing(code, 'css'));
            issues = issues.concat(ruleCreamPalette(code, 'css'));
            issues = issues.concat(ruleLowContrast(code));
            issues = issues.concat(ruleGrayOnColor(code));
            issues = issues.concat(ruleMonotonousSpacing(code));
        } else if (lang === 'javascript' || lang === 'js') {
            issues = issues.concat(ruleBounceEasing(code, 'javascript'));
            issues = issues.concat(ruleEmDashOveruse(code, 'javascript'));
            issues = issues.concat(rulePromptLanguageLeak(code, 'javascript'));
        }

        // 去重（同 id + 同 location + 同 detail 只保留一条）
        var seen = {};
        return issues.filter(function (it) {
            var key = it.id + '|' + it.location + '|' + it.detail;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    // ============================================================
    // 格式化函数
    // ============================================================

    /**
     * 将 issues 格式化为可读字符串，供 Agent 工具返回
     * @param {Array} issues detectAntipatterns 返回的 issues 数组
     * @returns {string}
     */
    function formatIssues(issues) {
        if (!issues || issues.length === 0) {
            return '[OK] 未检测到反模式';
        }
        var severityLabel = {
            'slop': 'AI味',
            'quality': '质量',
            'always-avoid': '底线'
        };
        var lines = [];
        lines.push('[WARN] 检测到 ' + issues.length + ' 个反模式：');
        issues.forEach(function (it, i) {
            lines.push('');
            lines.push((i + 1) + '. [' + (severityLabel[it.severity] || it.severity) + '] ' + it.title + '  (' + it.id + ')');
            lines.push('   位置: ' + it.location);
            lines.push('   问题: ' + it.detail);
            lines.push('   教导: ' + it.guideline);
        });
        return lines.join('\n');
    }

    // ============================================================
    // 暴露到全局
    // ============================================================
    global.AntipatternDetector = {
        detect: detectAntipatterns,
        rules: RULE_DEFINITIONS,
        format: formatIssues
    };

})(typeof window !== 'undefined' ? window : this);
