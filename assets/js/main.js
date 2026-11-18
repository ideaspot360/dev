// blogs/dev/assets/js/main.js (Extension: Modern Navigation & Search Engine - Hardened Production v2.0)

document.addEventListener("DOMContentLoaded", () => {
  // 1. Dark Mode Management (Preserved)
  initDarkModeToggle();

  // 2. Add 'Copy' button to all <pre> code blocks (Preserved)
  initCodeCopyButtons();

  // 3. Ultra-Precision Pan-Zoom Lightbox Engine (Preserved)
  initPanZoomLightbox();

  // 4. Master 2-Column Navigation, Search & Pagination Engine
  initMasterNavigationEngine();
});

function initDarkModeToggle() {
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
}

function initCodeCopyButtons() {
  const preBlocks = document.querySelectorAll("pre");
  preBlocks.forEach((pre) => {
    if (pre.querySelector(".copy-code-btn")) return;
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
}

function initMasterNavigationEngine() {
  const sidebar = document.getElementById("sidebar-nav");
  const postList = document.getElementById("post-list");
  const toggleBtn = document.getElementById("mobile-drawer-toggle");
  const closeBtn = document.getElementById("drawer-close-btn");
  const backdrop = document.getElementById("drawer-backdrop");
  const searchInput = document.getElementById("sidebar-search-input");
  const searchClearBtn = document.getElementById("sidebar-search-clear");

  // ============================================================
  // A. Mobile Drawer & Keyboard Accessibility Engine (All Pages)
  // ============================================================
  function openDrawer() {
    if (!sidebar) return;
    sidebar.classList.add("drawer-open");
    sidebar.setAttribute("aria-hidden", "false");
    if (backdrop) backdrop.classList.add("active");
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    setTimeout(() => {
      const firstInput = sidebar.querySelector("input:not([disabled]), button:not([disabled]), [href]");
      if (firstInput) firstInput.focus();
    }, 50);
  }

  function closeDrawer() {
    if (!sidebar) return;
    sidebar.classList.remove("drawer-open");
    if (window.innerWidth < 1024) {
      sidebar.setAttribute("aria-hidden", "true");
    }
    if (backdrop) backdrop.classList.remove("active");
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", "false");
      toggleBtn.focus();
    }
    document.body.style.overflow = "";
  }

  if (toggleBtn) toggleBtn.addEventListener("click", openDrawer);
  if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
  if (backdrop) backdrop.addEventListener("click", closeDrawer);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebar && sidebar.classList.contains("drawer-open")) {
      closeDrawer();
    }
  });

  // Mobile Drawer Accessible Focus Trap (Tab & Shift+Tab)
  if (sidebar) {
    sidebar.addEventListener("keydown", (e) => {
      if (!sidebar.classList.contains("drawer-open")) return;
      if (e.key === "Tab") {
        const focusables = Array.from(sidebar.querySelectorAll(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
        )).filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);

        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });
  }

  // Set initial aria-hidden on sidebar depending on screen width
  if (sidebar && window.innerWidth < 1024) {
    sidebar.setAttribute("aria-hidden", "true");
  }

  // ============================================================
  // B. Cross-Page Sidebar Navigation & Search Bindings (All Pages)
  // ============================================================
  if (sidebar) {
    sidebar.addEventListener("click", (e) => {
      // 1. Accordion Arrow Toggle
      const arrow = e.target.closest(".category-toggle-arrow");
      if (arrow) {
        e.stopPropagation();
        const group = arrow.closest(".category-group");
        if (group) {
          const isOpen = group.classList.toggle("open");
          const btn = group.querySelector(".category-group-header");
          if (btn) btn.setAttribute("aria-expanded", String(isOpen));
        }
        return;
      }

      // 2. Category Header Click
      const catBtn = e.target.closest(".category-group-header");
      if (catBtn) {
        const cat = catBtn.getAttribute("data-category") || "all";
        const group = catBtn.closest(".category-group");
        if (group) {
          const isOpen = group.classList.toggle("open");
          catBtn.setAttribute("aria-expanded", String(isOpen));
        }

        if (!postList) {
          // If on a post page or about page, navigate to homepage with category hash
          const slug = cat === "all" ? "" : `#cat=${encodeURIComponent(cat.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}`;
          window.location.href = `/${slug}`;
          return;
        }

        // On homepage: update state and render
        currentCategory = cat;
        currentTag = null;
        currentSearchQuery = "";
        if (searchInput) searchInput.value = "";
        if (searchClearBtn) searchClearBtn.classList.remove("visible");

        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
        if (window.innerWidth < 1024) closeDrawer();
        return;
      }

      // 3. Subitem Tag Link Click
      const subitem = e.target.closest(".category-subitem");
      if (subitem) {
        e.preventDefault();
        const tag = subitem.getAttribute("data-tag") || "";
        const parentCat = subitem.getAttribute("data-parent-category") || "all";

        if (!postList) {
          const catSlug = parentCat.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          const tagSlug = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          window.location.href = `/#cat=${encodeURIComponent(catSlug)}&tag=${encodeURIComponent(tagSlug)}`;
          return;
        }

        currentTag = tag;
        if (parentCat) currentCategory = parentCat;
        currentSearchQuery = "";
        if (searchInput) searchInput.value = "";
        if (searchClearBtn) searchClearBtn.classList.remove("visible");

        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
        if (window.innerWidth < 1024) closeDrawer();
        return;
      }

      // 4. View All in Category Click
      const viewAllCat = e.target.closest(".category-subitem-all");
      if (viewAllCat) {
        e.preventDefault();
        const cat = viewAllCat.getAttribute("data-category") || "all";
        if (!postList) {
          const slug = cat === "all" ? "" : `#cat=${encodeURIComponent(cat.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}`;
          window.location.href = `/${slug}`;
          return;
        }

        currentCategory = cat;
        currentTag = null;
        currentSearchQuery = "";
        if (searchInput) searchInput.value = "";
        if (searchClearBtn) searchClearBtn.classList.remove("visible");

        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
        if (window.innerWidth < 1024) closeDrawer();
        return;
      }

      // 5. Curated Series Trigger Link
      const seriesLink = e.target.closest(".series-link");
      if (seriesLink) {
        e.preventDefault();
        const trigger = seriesLink.getAttribute("data-search-trigger") || "";
        if (!postList) {
          window.location.href = `/#search=${encodeURIComponent(trigger)}`;
          return;
        }

        currentSearchQuery = trigger;
        if (searchInput) {
          searchInput.value = trigger;
          if (searchClearBtn) searchClearBtn.classList.add("visible");
        }
        currentCategory = "all";
        currentTag = null;
        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
        if (window.innerWidth < 1024) closeDrawer();
        return;
      }

      // 6. Popular Tag Cloud Pill Click
      const tagPill = e.target.closest(".sidebar-tag-pill");
      if (tagPill) {
        e.preventDefault();
        const tag = tagPill.getAttribute("data-tag") || "";
        if (!postList) {
          const tagSlug = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          window.location.href = `/#tag=${encodeURIComponent(tagSlug)}`;
          return;
        }

        currentTag = tag;
        currentCategory = "all";
        currentSearchQuery = "";
        if (searchInput) searchInput.value = "";
        if (searchClearBtn) searchClearBtn.classList.remove("visible");

        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
        if (window.innerWidth < 1024) closeDrawer();
        return;
      }
    });
  }

  // Sidebar Search Input: Handle Cross-Page Navigation on Enter
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const query = searchInput.value.trim();
        if (!postList) {
          if (query) {
            window.location.href = `/#search=${encodeURIComponent(query)}`;
          } else {
            window.location.href = `/`;
          }
          return;
        }
        // On homepage: immediate search evaluation
        currentSearchQuery = query;
        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
      } else if (e.key === "Escape") {
        clearSearch();
      }
    });
  }

  // Global Keyboard Shortcut (Ctrl+K or Cmd+K) - Active on ALL pages
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (window.innerWidth < 1024 && sidebar && !sidebar.classList.contains("drawer-open")) {
        openDrawer();
      }
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
  });

  // ============================================================
  // C. Homepage-Specific Listing, Filter & Pagination Engine
  // ============================================================
  if (!postList) return; // Safely exit if not on post listing page

  const cards = Array.from(postList.querySelectorAll(".post-card"));
  const searchBanner = document.getElementById("search-status-banner");
  const searchBannerText = document.getElementById("search-banner-text");
  const searchBannerClear = document.getElementById("search-banner-clear");
  const liveStatus = document.getElementById("search-live-status");

  const filterResetBtn = document.getElementById("filter-reset-btn");
  const activeFilterName = document.getElementById("active-filter-name");
  const activeFilterCount = document.getElementById("active-filter-count");
  const noPostsMsg = document.getElementById("no-posts-found");

  const sortSelector = document.getElementById("sort-selector");
  const viewCardBtn = document.getElementById("view-card-btn");
  const viewCompactBtn = document.getElementById("view-compact-btn");

  const paginationWrapper = document.getElementById("pagination-wrapper");
  const paginationNumbers = document.getElementById("pagination-numbers");
  const paginationPrev = document.getElementById("pagination-prev");
  const paginationNext = document.getElementById("pagination-next");

  // State Management
  let currentCategory = "all";
  let currentTag = null;
  let currentSearchQuery = "";
  let currentSort = "latest";
  let currentViewMode = localStorage.getItem("post-view-mode") || "cards";
  let currentPage = 1;
  let searchIndex = null;
  let searchIndexLoading = false;

  function getPageSize() {
    return currentViewMode === "compact" ? 25 : 12;
  }

  // 1. View Mode Management
  if (viewCardBtn && viewCompactBtn) {
    applyViewMode(currentViewMode, false);

    viewCardBtn.addEventListener("click", () => applyViewMode("cards", true));
    viewCompactBtn.addEventListener("click", () => applyViewMode("compact", true));

    function applyViewMode(mode, execute = true) {
      currentViewMode = mode;
      localStorage.setItem("post-view-mode", mode);
      if (mode === "compact") {
        postList.classList.add("compact-view");
        viewCompactBtn.classList.add("active");
        viewCompactBtn.setAttribute("aria-pressed", "true");
        viewCardBtn.classList.remove("active");
        viewCardBtn.setAttribute("aria-pressed", "false");
      } else {
        postList.classList.remove("compact-view");
        viewCardBtn.classList.add("active");
        viewCardBtn.setAttribute("aria-pressed", "true");
        viewCompactBtn.classList.remove("active");
        viewCompactBtn.setAttribute("aria-pressed", "false");
      }
      if (execute) {
        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
      }
    }
  }

  // 2. Genuine Search Index Loader with DOM Fallback
  async function loadSearchIndex() {
    if (searchIndex || searchIndexLoading) return searchIndex;
    searchIndexLoading = true;
    try {
      const res = await fetch("/search.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      searchIndex = await res.json();
    } catch (err) {
      console.warn("Using in-memory DOM search index fallback:", err);
      if (cards && cards.length > 0) {
        searchIndex = cards.map((c) => ({
          title: (c.getAttribute("data-title") || c.querySelector("h2")?.textContent || "").toLowerCase(),
          excerpt: (c.querySelector(".post-excerpt")?.textContent || "").toLowerCase(),
          category: c.getAttribute("data-category") || "Engineering",
          tags: (c.getAttribute("data-tags") || "").split(",").map(t => t.trim().toLowerCase()),
          url: c.getAttribute("href")
        }));
      } else {
        searchIndex = [];
      }
    } finally {
      searchIndexLoading = false;
    }
    return searchIndex;
  }

  if (searchInput) {
    searchInput.addEventListener("focus", loadSearchIndex, { once: true });
    searchInput.addEventListener("mouseenter", loadSearchIndex, { once: true });
  }

  // 3. Central Filter, Sort & Pagination Execution Engine
  function executeFilterAndRender(options = { updateHash: true, isUserAction: false }) {
    const query = currentSearchQuery.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);

    // Step A: Matching Cards with Genuine searchIndex + DOM Fallback
    let matched = cards.filter((card) => {
      const cat = card.getAttribute("data-category") || "Engineering";
      const extraCats = (card.getAttribute("data-categories") || "").split(",").map(c => c.trim().toLowerCase());
      const tags = (card.getAttribute("data-tags") || "").split(",").map(t => t.trim().toLowerCase());

      const matchCat = (currentCategory === "all") || (cat === currentCategory) || extraCats.includes(currentCategory.toLowerCase());
      const matchTag = !currentTag || tags.includes(currentTag.toLowerCase());

      if (!matchCat || !matchTag) return false;
      if (terms.length === 0) return true;

      // Primary Search: evaluate against searchIndex when loaded
      if (searchIndex && searchIndex.length > 0) {
        const cardUrl = card.getAttribute("href");
        const indexedItem = searchIndex.find(item => item.url === cardUrl);
        if (indexedItem) {
          return terms.every((term) =>
            (indexedItem.title && indexedItem.title.toLowerCase().includes(term)) ||
            (indexedItem.excerpt && indexedItem.excerpt.toLowerCase().includes(term)) ||
            (indexedItem.tags && indexedItem.tags.some(t => t.toLowerCase().includes(term))) ||
            (indexedItem.category && indexedItem.category.toLowerCase().includes(term))
          );
        }
      }

      // Fallback Search: evaluate against DOM attributes & excerpt
      const title = (card.getAttribute("data-title") || "").toLowerCase();
      const excerpt = (card.querySelector(".post-excerpt")?.textContent || "").toLowerCase();
      return terms.every((term) =>
        title.includes(term) ||
        excerpt.includes(term) ||
        tags.some(t => t.includes(term)) ||
        cat.toLowerCase().includes(term)
      );
    });

    // Step B: Sorting
    matched.sort((a, b) => {
      if (currentSort === "oldest") {
        return (a.getAttribute("data-date") || "").localeCompare(b.getAttribute("data-date") || "");
      } else if (currentSort === "title") {
        return (a.getAttribute("data-title") || "").localeCompare(b.getAttribute("data-title") || "");
      } else {
        return (b.getAttribute("data-date") || "").localeCompare(a.getAttribute("data-date") || "");
      }
    });

    // Step C: Re-order DOM elements
    matched.forEach(card => postList.appendChild(card));

    // Step D: Progressive Slicing & Defensive Page Bounds
    const pageSize = getPageSize();
    const totalPages = Math.ceil(matched.length / pageSize) || 1;

    // Defensive clamping: guarantee 1 <= currentPage <= totalPages
    if (isNaN(currentPage) || currentPage < 1) {
      currentPage = 1;
    } else if (currentPage > totalPages) {
      currentPage = totalPages;
    }

    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;

    // O(1) Visibility Lookup Optimization via Set
    const visibleSet = new Set(matched.slice(startIndex, endIndex));
    cards.forEach((card) => {
      if (visibleSet.has(card)) {
        card.style.display = "block";
      } else {
        card.style.display = "none";
      }
    });

    // Step E: Status Indicators
    if (activeFilterName) {
      if (currentSearchQuery) {
        activeFilterName.textContent = `Search: "${currentSearchQuery}"`;
      } else if (currentTag) {
        activeFilterName.textContent = `Tag: #${currentTag}`;
      } else if (currentCategory === "all") {
        activeFilterName.textContent = "All Articles";
      } else {
        activeFilterName.textContent = currentCategory;
      }
    }

    if (activeFilterCount) {
      activeFilterCount.textContent = `(${matched.length})`;
    }

    if (filterResetBtn) {
      const isFiltered = currentCategory !== "all" || currentTag !== null || currentSearchQuery !== "";
      filterResetBtn.style.display = isFiltered ? "inline-block" : "none";
    }

    if (noPostsMsg) {
      noPostsMsg.style.display = matched.length === 0 ? "block" : "none";
    }

    if (searchBanner && searchBannerText) {
      if (currentSearchQuery) {
        searchBanner.style.display = "flex";
        searchBannerText.textContent = `Found ${matched.length} article${matched.length === 1 ? "" : "s"} for "${currentSearchQuery}"`;
      } else {
        searchBanner.style.display = "none";
      }
    }

    if (liveStatus) {
      liveStatus.textContent = `${matched.length} articles found. Showing page ${currentPage} of ${totalPages}.`;
    }

    // Step F: Render Pagination Controls
    renderPagination(totalPages);

    // Step G: Synchronize Active Sidebar States
    updateSidebarActiveStates();

    // Step H: Update URL Hash with History Management
    if (options.updateHash) {
      updateUrlHash(options.isUserAction);
    }
  }

  function renderPagination(totalPages) {
    if (!paginationWrapper || !paginationNumbers) return;

    if (totalPages <= 1) {
      paginationWrapper.style.display = "none";
      return;
    }

    paginationWrapper.style.display = "flex";
    paginationPrev.disabled = (currentPage === 1);
    paginationNext.disabled = (currentPage === totalPages);

    paginationNumbers.innerHTML = "";
    for (let p = 1; p <= totalPages; p++) {
      const btn = document.createElement("button");
      btn.className = `page-number-btn ${p === currentPage ? "active" : ""}`;
      btn.textContent = p;
      btn.setAttribute("aria-label", `Page ${p}`);
      btn.addEventListener("click", () => {
        currentPage = p;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
        window.scrollTo({ top: postList.offsetTop - 80, behavior: "smooth" });
      });
      paginationNumbers.appendChild(btn);
    }
  }

  if (paginationPrev) {
    paginationPrev.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
        window.scrollTo({ top: postList.offsetTop - 80, behavior: "smooth" });
      }
    });
  }

  if (paginationNext) {
    paginationNext.addEventListener("click", () => {
      currentPage++;
      executeFilterAndRender({ updateHash: true, isUserAction: true });
      window.scrollTo({ top: postList.offsetTop - 80, behavior: "smooth" });
    });
  }

  function updateSidebarActiveStates() {
    document.querySelectorAll(".category-group-header").forEach((btn) => {
      const cat = btn.getAttribute("data-category");
      const match = (cat === currentCategory) && !currentTag && !currentSearchQuery;
      btn.classList.toggle("active", match);
    });

    document.querySelectorAll(".category-subitem").forEach((item) => {
      const tag = item.getAttribute("data-tag");
      const match = (tag === currentTag);
      item.classList.toggle("active", match);
    });

    document.querySelectorAll(".sidebar-tag-pill").forEach((pill) => {
      const tag = pill.getAttribute("data-tag");
      const match = (tag === currentTag);
      pill.classList.toggle("active", match);
    });
  }

  // 4. URL Hash Management with pushState vs replaceState
  function updateUrlHash(isUserAction = false) {
    const params = [];
    if (currentCategory !== "all") {
      params.push(`cat=${encodeURIComponent(currentCategory.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}`);
    }
    if (currentTag) {
      params.push(`tag=${encodeURIComponent(currentTag.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}`);
    }
    if (currentSearchQuery) {
      params.push(`search=${encodeURIComponent(currentSearchQuery)}`);
    }
    if (currentPage > 1) {
      params.push(`p=${currentPage}`);
    }

    const targetHash = params.length > 0 ? `#${params.join("&")}` : "";
    const currentUrlHash = window.location.hash;

    if (targetHash !== currentUrlHash) {
      const stateObj = { category: currentCategory, tag: currentTag, search: currentSearchQuery, page: currentPage };
      if (isUserAction) {
        history.pushState(stateObj, "", targetHash || window.location.pathname);
      } else {
        history.replaceState(stateObj, "", targetHash || window.location.pathname);
      }
    }
  }

  // 5. Search Input Debounce
  let searchDebounceTimer = null;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(async () => {
        currentSearchQuery = e.target.value;
        if (searchClearBtn) {
          searchClearBtn.classList.toggle("visible", currentSearchQuery.length > 0);
        }
        await loadSearchIndex();
        currentPage = 1;
        executeFilterAndRender({ updateHash: true, isUserAction: true });
      }, 150);
    });
  }

  function clearSearch() {
    if (searchInput) {
      searchInput.value = "";
      currentSearchQuery = "";
      if (searchClearBtn) searchClearBtn.classList.remove("visible");
      currentPage = 1;
      executeFilterAndRender({ updateHash: true, isUserAction: true });
      searchInput.focus();
    }
  }

  if (searchClearBtn) searchClearBtn.addEventListener("click", clearSearch);
  if (searchBannerClear) searchBannerClear.addEventListener("click", clearSearch);

  // 6. Reset & Sort Events
  if (filterResetBtn) {
    filterResetBtn.addEventListener("click", () => {
      currentCategory = "all";
      currentTag = null;
      currentSearchQuery = "";
      if (searchInput) searchInput.value = "";
      if (searchClearBtn) searchClearBtn.classList.remove("visible");
      currentPage = 1;
      executeFilterAndRender({ updateHash: true, isUserAction: true });
    });
  }

  if (sortSelector) {
    sortSelector.addEventListener("change", (e) => {
      currentSort = e.target.value;
      currentPage = 1;
      executeFilterAndRender({ updateHash: true, isUserAction: true });
    });
  }

  // 7. URL Hash Routing Parser with Dual-Syntax Compatibility & Defensive Page Bounds
  function parseUrlHashAndApply() {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) {
      currentCategory = "all";
      currentTag = null;
      currentSearchQuery = "";
      currentPage = 1;
      executeFilterAndRender({ updateHash: false });
      return;
    }

    const segments = hash.split("&");
    segments.forEach((seg) => {
      let key = "";
      let val = "";
      if (seg.includes("=")) {
        const parts = seg.split("=");
        key = parts[0];
        val = parts.slice(1).join("=");
      } else if (seg.startsWith("cat-")) {
        key = "cat";
        val = seg.slice(4);
      } else if (seg.startsWith("tag-")) {
        key = "tag";
        val = seg.slice(4);
      } else if (seg.startsWith("search-")) {
        key = "search";
        val = seg.slice(7);
      } else if (seg.startsWith("p-")) {
        key = "p";
        val = seg.slice(2);
      }

      if (key === "cat" && val) {
        const targetSlug = decodeURIComponent(val).toLowerCase();
        let found = false;
        document.querySelectorAll(".category-group-header").forEach((btn) => {
          const cat = btn.getAttribute("data-category") || "";
          if (cat.toLowerCase().replace(/[^a-z0-9]+/g, "-") === targetSlug) {
            currentCategory = cat;
            found = true;
            const group = btn.closest(".category-group");
            if (group) {
              group.classList.add("open");
              btn.setAttribute("aria-expanded", "true");
            }
          }
        });
        if (!found) currentCategory = "all";
      } else if (key === "tag" && val) {
        currentTag = decodeURIComponent(val);
      } else if (key === "search" && val) {
        currentSearchQuery = decodeURIComponent(val);
        if (searchInput) {
          searchInput.value = currentSearchQuery;
          if (searchClearBtn) searchClearBtn.classList.add("visible");
        }
      } else if (key === "p" && val) {
        let p = parseInt(val, 10);
        currentPage = isNaN(p) || p < 1 ? 1 : p;
      }
    });

    executeFilterAndRender({ updateHash: false });
  }

  // Initial Load Parse
  parseUrlHashAndApply();

  // Dual Listener: popstate (for back/forward button) and hashchange (for direct anchor clicks)
  window.addEventListener("popstate", parseUrlHashAndApply);
  window.addEventListener("hashchange", parseUrlHashAndApply);
}

// ============================================================
// Ultra-Precision Pan-Zoom Lightbox Engine (Preserved)
// ============================================================
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
    <div class="panzoom-hint">🖱️ 휠: 줌 인/아웃 | 드래그/방향키: 이동 | 더블클릭: 2.5x | +, -: 줌 | 0/R: 리셋 | ESC: 닫기</div>
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
  let hasDragged = false;
  let dragStartX = 0;
  let dragStartY = 0;
  const DRAG_THRESHOLD = 5; // 5px 이상 움직이면 '팬(Pan)' 동작으로 확정
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
    if (e.target.closest(".panzoom-toolbar, .lightbox-toolbar")) return;
    isDragging = true;
    hasDragged = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    viewport.classList.add("grabbing");
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const moveDist = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
    if (moveDist > DRAG_THRESHOLD) {
      hasDragged = true;
    }
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    updateTransform(false);
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      viewport.classList.remove("grabbing");
      setTimeout(() => {
        hasDragged = false;
      }, 50);
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
      hasDragged = false;
      dragStartX = e.touches[0].clientX;
      dragStartY = e.touches[0].clientY;
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
      const moveDist = Math.hypot(e.touches[0].clientX - dragStartX, e.touches[0].clientY - dragStartY);
      if (moveDist > DRAG_THRESHOLD) {
        hasDragged = true;
      }
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
    setTimeout(() => {
      hasDragged = false;
    }, 50);
  });

  // Toolbar Button Clicks
  btnIn.addEventListener("click", () => zoomAt(scale * 1.3, 0, 0));
  btnOut.addEventListener("click", () => zoomAt(scale / 1.3, 0, 0));
  btnReset.addEventListener("click", resetZoom);
  btnClose.addEventListener("click", closeModal);

  // Close on Backdrop Click
  viewport.addEventListener("click", (e) => {
    if (hasDragged) {
      e.stopPropagation();
      return;
    }
    if (e.target === viewport) {
      closeModal();
    }
  });

  // Keyboard Navigation & Shortcuts (+, -, 0, R, Arrow keys, ESC)
  window.addEventListener("keydown", (e) => {
    if (!modal.classList.contains("active")) return;

    if (e.key === "Escape") {
      closeModal();
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomAt(scale * 1.25, 0, 0);
      updateTransform(true);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomAt(scale * 0.8, 0, 0);
      updateTransform(true);
    } else if (e.key === "0" || e.key === "r" || e.key === "R") {
      e.preventDefault();
      resetZoom();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      translateX += 50;
      updateTransform(true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      translateX -= 50;
      updateTransform(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      translateY += 50;
      updateTransform(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      translateY -= 50;
      updateTransform(true);
    }
  });
}
