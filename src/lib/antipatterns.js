(function (global) {
  'use strict';

  const RULES = [
    {
      id: 'transition-all',
      severity: 'quality',
      test: /transition\s*:\s*all\b/i,
      message: '避免 transition: all；只声明实际变化的属性。'
    },
    {
      id: 'unsafe-eval',
      severity: 'always-avoid',
      test: /\beval\s*\(/,
      message: '不要使用 eval()。'
    },
    {
      id: 'document-write',
      severity: 'quality',
      test: /document\.write\s*\(/,
      message: '避免 document.write()，它会破坏页面加载流程。'
    },
    {
      id: 'purple-blue-gradient',
      severity: 'slop',
      test: /linear-gradient\([^)]*(?:purple|violet|#7c3aed|#8b5cf6)[^)]*(?:blue|#2563eb|#3b82f6)/i,
      message: '检测到常见紫蓝渐变，请确认它确实符合项目规范。'
    },
    {
      id: 'fixed-mobile-width',
      severity: 'quality',
      test: /width\s*:\s*(?:[4-9]\d{2}|\d{4,})px/i,
      message: '检测到较大的固定宽度，请检查 320px 手机视口是否溢出。'
    }
  ];

  function detect(code) {
    const text = String(code || '');
    return RULES.filter(rule => rule.test.test(text)).map(rule => ({
      id: rule.id,
      severity: rule.severity,
      message: rule.message
    }));
  }

  function format(issues) {
    return (issues || []).map((issue, index) => {
      const label = issue.severity === 'always-avoid' ? '底线' : issue.severity === 'slop' ? 'AI味' : '质量';
      return `${index + 1}. [${label}] ${issue.message}`;
    }).join('\n');
  }

  global.AntipatternDetector = { detect, format };
})(window);
