// IdeaSpot360 Dev - Core Interactive Engine
// Dark Mode Toggle & One-Click Code Block Copy

document.addEventListener("DOMContentLoaded", () => {
  // 1. Dark Mode Management
  const themeToggle = document.getElementById("theme-toggle");
  const currentTheme = localStorage.getItem("theme");

  if (currentTheme) {
    document.documentElement.setAttribute("data-theme", currentTheme);
    updateThemeIcon(currentTheme);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    updateThemeIcon(prefersDark ? "dark" : "light");
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      let theme = document.documentElement.getAttribute("data-theme");
      if (!theme) {
        theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      const newTheme = theme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", newTheme);
      localStorage.setItem("theme", newTheme);
      updateThemeIcon(newTheme);
    });
  }

  function updateThemeIcon(theme) {
    if (!themeToggle) return;
    themeToggle.textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
  }

  // 2. Add 'Copy' button to all <pre> code blocks
  const preBlocks = document.querySelectorAll("pre");
  preBlocks.forEach((pre) => {
    const button = document.createElement("button");
    button.className = "copy-code-btn";
    button.textContent = "Copy";

    button.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      const textToCopy = code ? code.innerText : pre.innerText;

      try {
        await navigator.clipboard.writeText(textToCopy);
        button.textContent = "Copied!";
        button.style.backgroundColor = "#10b981";
        setTimeout(() => {
          button.textContent = "Copy";
          button.style.backgroundColor = "";
        }, 2000);
      } catch (err) {
        button.textContent = "Failed";
      }
    });

    pre.appendChild(button);
  });

  // 3. Ultra-Precision Pan-Zoom Lightbox Engine
  initPanZoomLightbox();
});

function initPanZoomLightbox() {
  const images = document.querySelectorAll(".entry-content img, article.post-content img");
  if (!images.length) return;

  // Create Modal DOM Elements once
  const modal = document.createElement("div");
  modal.className = "panzoom-modal";
  modal.innerHTML = `
    <div class="panzoom-toolbar">
      <span class="panzoom-scale-badge" id="pz-scale">100%</span>
      <button class="panzoom-btn" id="pz-zoom-out" title="축소 (-)">−</button>
      <button class="panzoom-btn" id="pz-zoom-in" title="확대 (+)">+</button>
      <button class="panzoom-btn" id="pz-reset" title="원래 크기 (리셋)">↺</button>
      <button class="panzoom-btn" id="pz-close" title="닫기 (Esc)" style="margin-left: 6px; font-weight: bold;">✕</button>
    </div>
    <div class="panzoom-viewport" id="pz-viewport">
      <img class="panzoom-image" id="pz-image" src="" alt="Zoomable Image">
    </div>
    <div class="panzoom-hint">🖱️ 휠: 줌 인/아웃 | 드래그: 이동 (Pan) | 더블클릭: 2.5x 확대 | ESC: 닫기</div>
  `;
  document.body.appendChild(modal);

  const viewport = modal.querySelector("#pz-viewport");
  const pzImage = modal.querySelector("#pz-image");
  const scaleBadge = modal.querySelector("#pz-scale");
  const btnIn = modal.querySelector("#pz-zoom-in");
  const btnOut = modal.querySelector("#pz-zoom-out");
  const btnReset = modal.querySelector("#pz-reset");
  const btnClose = modal.querySelector("#pz-close");

  let scale = 1.0;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let lastPinchDist = null;

  const MIN_SCALE = 0.5;
  const MAX_SCALE = 6.0;

  function updateTransform(smooth = false) {
    pzImage.style.transition = smooth ? "transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)" : "none";
    pzImage.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`;
    scaleBadge.textContent = `${Math.round(scale * 100)}%`;
  }

  function resetZoom() {
    scale = 1.0;
    translateX = 0;
    translateY = 0;
    updateTransform(true);
  }

  function openModal(src, alt) {
    pzImage.src = src;
    pzImage.alt = alt || "Technical Diagram";
    resetZoom();
    modal.classList.add("active");
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    modal.classList.remove("active");
    document.body.style.overflow = "";
    setTimeout(() => {
      pzImage.src = "";
    }, 250);
  }

  // Bind clicks to all article images
  images.forEach((img) => {
    img.addEventListener("click", () => {
      openModal(img.src, img.alt);
    });
  });

  // Zoom In / Out functions
  function zoomAt(targetScale, focalX = 0, focalY = 0) {
    const clampedScale = Math.min(Math.max(targetScale, MIN_SCALE), MAX_SCALE);
    if (clampedScale === scale) return;

    const ratio = clampedScale / scale;
    translateX = focalX - ratio * (focalX - translateX);
    translateY = focalY - ratio * (focalY - translateY);
    scale = clampedScale;

    updateTransform(false);
  }

  // 1. Mouse Wheel Zoom (centered on cursor)
  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const focalX = e.clientX - rect.left - rect.width / 2;
    const focalY = e.clientY - rect.top - rect.height / 2;

    const delta = -e.deltaY * 0.002;
    const targetScale = scale * (1 + delta);
    zoomAt(targetScale, focalX, focalY);
  }, { passive: false });

  // 2. Mouse Drag Pan
  viewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // Only left click
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    viewport.classList.add("grabbing");
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    updateTransform(false);
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      viewport.classList.remove("grabbing");
    }
  });

  // 3. Double Click Toggle
  viewport.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (scale > 1.05) {
      resetZoom();
    } else {
      const rect = viewport.getBoundingClientRect();
      const focalX = e.clientX - rect.left - rect.width / 2;
      const focalY = e.clientY - rect.top - rect.height / 2;
      zoomAt(2.5, focalX, focalY);
    }
  });

  // 4. Touch support (Mobile Pinch-to-zoom & Pan)
  viewport.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      startX = e.touches[0].clientX - translateX;
      startY = e.touches[0].clientY - translateY;
    } else if (e.touches.length === 2) {
      isDragging = false;
      lastPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  viewport.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && isDragging) {
      translateX = e.touches[0].clientX - startX;
      translateY = e.touches[0].clientY - startY;
      updateTransform(false);
    } else if (e.touches.length === 2 && lastPinchDist) {
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const diff = currentDist / lastPinchDist;
      lastPinchDist = currentDist;
      zoomAt(scale * diff, 0, 0);
    }
  }, { passive: true });

  viewport.addEventListener("touchend", () => {
    isDragging = false;
    lastPinchDist = null;
  });

  // Toolbar Button Clicks
  btnIn.addEventListener("click", () => zoomAt(scale * 1.3, 0, 0));
  btnOut.addEventListener("click", () => zoomAt(scale / 1.3, 0, 0));
  btnReset.addEventListener("click", resetZoom);
  btnClose.addEventListener("click", closeModal);

  // Close on Backdrop Click
  modal.addEventListener("click", (e) => {
    if (e.target === viewport || e.target === modal) {
      closeModal();
    }
  });

  // Close on ESC Key
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
    }
  });
}

