(() => {
  const d = document;
  const root = d.documentElement;
  const backdropSupported = CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
  const svgBackdropSupported = CSS.supports('backdrop-filter', 'url(#x)') || CSS.supports('-webkit-backdrop-filter', 'url(#x)');
  const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const isTouch = matchMedia('(hover: none)').matches || navigator.maxTouchPoints > 0;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const boundPressables = new WeakSet();
  const observedSurfaces = new WeakSet();
  let resizeObserver = null;

  root.classList.toggle('supports-backdrop', backdropSupported);
  root.classList.toggle('no-backdrop', !backdropSupported);
  root.classList.toggle('supports-svg-backdrop', svgBackdropSupported);
  root.classList.toggle('no-svg-backdrop', !svgBackdropSupported);

  const surfaceGroups = [
    {
      selectors: [
        '.sidebar',
        '.chat-topbar',
        '.message-input-bar',
        '.message-composer-shell',
        '.right-panel',
        '.modal',
        '.conn-status',
        '.reply-preview-bar',
        '.search-bar',
        '.right-panel-code',
        '.profile-push-card',
        '.profile-ai-usage-card',
        '.user-management-global-card',
        '.user-management-user',
        '.diagnostics-item',
      ],
      classes: ['liquid-surface'],
    },
    {
      selectors: [
        '.chat-topbar',
        '.conn-status',
        '.reply-preview-bar',
        '.unread-jump-btn',
        '.scroll-bottom-btn',
      ],
      classes: ['liquid-surface', 'liquid-pill'],
    },
    {
      selectors: [
        '.sidebar',
        '.right-panel',
        '.modal',
      ],
      classes: ['liquid-surface', 'liquid-sheet'],
    },
    {
      selectors: [
        '.slash-command-menu',
        '.emoji-picker',
        '.whisper-picker',
        '.ctx-menu',
        '.mobile-sidebar-actions-menu',
      ],
      classes: ['liquid-surface', 'liquid-popover'],
    },
  ];

  const pressableSelectors = [
    '.btn-icon',
    '.btn-send',
    '.btn-action',
    '.btn-action-sm',
    '.btn-primary',
    '.btn-secondary',
    '.btn-danger',
    '.btn-quick-action',
    '.group-item',
    '.member-item',
    '.whisper-picker-item',
    '.slash-command-item',
    '.emoji-btn-item',
    '.ctx-item',
    '.chat-tag-filter-btn',
    '.grok-model-option',
    '.mobile-sidebar-action',
    '.user-management-expand-btn',
    '.user-management-save-btn',
    '.user-management-delete-btn',
    '.scroll-bottom-btn',
    '.unread-jump-btn',
  ];

  function ready(fn) {
    if (d.readyState === 'loading') {
      d.addEventListener('DOMContentLoaded', fn, { once: true });
      return;
    }
    fn();
  }

  function updateSurfaceMetrics(el) {
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--liquid-surface-width', `${Math.round(rect.width)}px`);
    el.style.setProperty('--liquid-surface-height', `${Math.round(rect.height)}px`);
  }

  function ensureSurfaceObserver() {
    if (resizeObserver || !('ResizeObserver' in window)) return;
    resizeObserver = new ResizeObserver((entries) => {
      entries.forEach((entry) => updateSurfaceMetrics(entry.target));
    });
  }

  function observeSurface(el) {
    ensureSurfaceObserver();
    if (!resizeObserver || observedSurfaces.has(el)) return;
    observedSurfaces.add(el);
    updateSurfaceMetrics(el);
    resizeObserver.observe(el);
  }

  function bindPressable(el) {
    if (boundPressables.has(el) || isTouch || reducedMotionQuery.matches) return;
    boundPressables.add(el);
    let frame = 0;
    const reset = () => {
      cancelAnimationFrame(frame);
      el.style.setProperty('--liquid-x', '0px');
      el.style.setProperty('--liquid-y', '0px');
      el.style.setProperty('--liquid-scale', '1');
    };

    el.addEventListener('pointermove', (ev) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = ((ev.clientX - rect.left) / rect.width - 0.5) * 7;
        const y = ((ev.clientY - rect.top) / rect.height - 0.5) * 7;
        el.style.setProperty('--liquid-x', `${x.toFixed(2)}px`);
        el.style.setProperty('--liquid-y', `${y.toFixed(2)}px`);
      });
    });
    el.addEventListener('pointerdown', () => {
      el.style.setProperty('--liquid-scale', '0.972');
    });
    el.addEventListener('pointerup', reset);
    el.addEventListener('pointercancel', reset);
    el.addEventListener('pointerleave', reset);
    el.addEventListener('blur', reset, true);
  }

  function syncKeyboardInset() {
    if (!window.visualViewport) return;
    const set = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop));
      root.style.setProperty('--keyboard-inset', `${inset}px`);
    };
    window.visualViewport.addEventListener('resize', set);
    window.visualViewport.addEventListener('scroll', set);
    set();
  }

  function syncCompactBars() {
    const area = d.querySelector('#messages-area, .messages-area');
    const topbar = d.querySelector('.chat-topbar');
    const composer = d.querySelector('.message-input-bar');
    if (!area || !topbar || area.dataset.liquidScrollBound === 'true') return;
    area.dataset.liquidScrollBound = 'true';
    let lastScrollTop = area.scrollTop;
    let ticking = false;

    area.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const nextScrollTop = area.scrollTop;
        const compact = nextScrollTop > lastScrollTop + 8 && nextScrollTop > 80;
        const expanded = nextScrollTop < lastScrollTop - 8 || nextScrollTop < 40;
        if (compact) {
          topbar.classList.add('is-compact');
          composer?.classList.add('is-compact');
        } else if (expanded) {
          topbar.classList.remove('is-compact');
          composer?.classList.remove('is-compact');
        }
        lastScrollTop = nextScrollTop;
        ticking = false;
      });
    }, { passive: true });
  }

  function markElements() {
    surfaceGroups.forEach(({ selectors, classes }) => {
      selectors.forEach((selector) => {
        d.querySelectorAll(selector).forEach((el) => {
          el.setAttribute('data-liquid-surface', '');
          classes.forEach((className) => el.classList.add(className));
          observeSurface(el);
        });
      });
    });

    pressableSelectors.forEach((selector) => {
      d.querySelectorAll(selector).forEach((el) => {
        el.setAttribute('data-liquid-pressable', '');
        bindPressable(el);
      });
    });

    d.querySelectorAll('.scroll-bottom-btn').forEach((el) => {
      el.style.setProperty('--liquid-base-y', 'calc(var(--keyboard-inset, 0px) * -1)');
    });
  }

  ready(() => {
    d.body.classList.add('ios-liquid');
    d.body.classList.toggle('ios-liquid-conservative', !backdropSupported || isIOS);
    markElements();
    syncKeyboardInset();
    syncCompactBars();

    const observer = new MutationObserver(() => {
      markElements();
      syncCompactBars();
    });
    observer.observe(d.body, { childList: true, subtree: true });

    if (typeof reducedMotionQuery.addEventListener === 'function') {
      reducedMotionQuery.addEventListener('change', () => {
        if (reducedMotionQuery.matches) {
          d.querySelectorAll('[data-liquid-pressable]').forEach((el) => {
            el.style.setProperty('--liquid-x', '0px');
            el.style.setProperty('--liquid-y', '0px');
            el.style.setProperty('--liquid-scale', '1');
          });
        } else {
          markElements();
        }
      });
    }
  });
})();
