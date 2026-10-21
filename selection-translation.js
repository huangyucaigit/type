(function () {
  "use strict";

  const MAX_TEXT_LENGTH = 2000;
  const MAX_CACHE_SIZE = 100;
  const TYPE_LABELS = { word: "单词", phrase: "短语", sentence: "句子", passage: "多句或段落", fragment: "不完整片段" };

  function create({ input, display, area, popup, sourceLabel, translationLabel, statusLabel,
    retryButton, closeButton, typeLabel, briefContainer, detailsContainer, expandButton, learnAction, learnButton, sentenceButton,
    assistantButton, onAddToAssistant = null,
    getReferenceText = () => "", isActive = () => true,
    isPrimaryActive = () => true, getAdditionalSources = () => [] }) {
    const cache = new Map();
    const sourceIds = new WeakMap();
    let sourceSequence = 0;
    let revision = 0;
    let current = null;
    let dismissedKey = null;
    let hasDetails = false;
    let popupEngaged = false;
    let actionSelection = null;
    let pressedSelection = null;
    let actionPressed = false;
    let actionPointerId = null;
    let pressedButton = null;
    let selectingWithMouse = false;
    let selectionPoint = null;
    let touchInteraction = Boolean(window.navigator?.maxTouchPoints > 0);
    try { touchInteraction ||= Boolean(window.matchMedia?.("(any-pointer: coarse)").matches); } catch { /* Pointer events also identify touch devices. */ }

    function touchPointer(event) {
      return event.pointerType === "touch" || event.pointerType === "pen";
    }

    function reference() {
      try { return String(getReferenceText() || ""); } catch { return ""; }
    }

    function sourceIdentity(sourceDisplay) {
      if (!sourceIds.has(sourceDisplay)) sourceIds.set(sourceDisplay, ++sourceSequence);
      return `${sourceDisplay.id || "source"}:${sourceIds.get(sourceDisplay)}`;
    }

    function visibleSource(source) {
      if (!source?.display || source.display.isConnected === false) return false;
      for (const element of [source.display, source.area]) {
        for (let node = element; node; node = node.parentNode || node.parentElement) {
          if (node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
        }
      }
      return true;
    }

    function additionalSources() {
      if (!isActive()) return [];
      try {
        const sources = getAdditionalSources();
        return Array.isArray(sources) ? sources.filter(visibleSource) : [];
      } catch { return []; }
    }

    function localReference(source) {
      try { return String(source.getReferenceText?.() || ""); } catch { return ""; }
    }

    function sourceAvailable(selected) {
      if (!selected || !isActive()) return false;
      if (selected.kind === "additional") {
        return additionalSources().some(source => source.display === selected.sourceDisplay
          && localReference(source) === selected.localReference);
      }
      return selected.kind === "snapshot" || (isPrimaryActive() && visibleSource({ display, area })
        && (selected.referenceText === undefined || selected.referenceText === reference()));
    }

    function genericOffset(sourceDisplay, node, offset, source) {
      try {
        const prefix = document.createRange();
        prefix.selectNodeContents(sourceDisplay);
        prefix.setEnd(node, offset);
        const text = prefix.toString();
        return source.slice(0, text.length) === text ? text.length : null;
      } catch { return null; }
    }

    // The display paints one span per Unicode character. Mapping these spans
    // to the reference also works when an earlier typo has a different UTF-16
    // length. Empty caret/wbr nodes and CSS whitespace markers add no offset.
    function displayOffset(node, offset, source) {
      const children = Array.from(display.childNodes || []);
      const characters = children.filter(child => child.classList?.contains("character")
        || String(child.className || "").split(/\s+/u).includes("character"));
      const characterSet = new Set(characters);
      const referenceCharacters = Array.from(source);
      const units = index => referenceCharacters.slice(0, index).join("").length;
      if (characters.length) {
        if (node === display) return units(children.slice(0, offset).filter(child => characterSet.has(child)).length);
        let character = node;
        while (character && character.parentNode !== display && character.parentElement !== display) {
          character = character.parentNode || character.parentElement;
        }
        const index = characters.indexOf(character);
        if (index >= 0 && index < referenceCharacters.length) {
          try {
            const prefix = document.createRange();
            prefix.selectNodeContents(character);
            prefix.setEnd(node, offset);
            const local = prefix.toString().length;
            const length = String(character.textContent || "").length;
            if (local === 0) return units(index);
            if (local === length) return units(index + 1);
            if (String(character.textContent) === referenceCharacters[index]) return units(index) + local;
          } catch { return null; }
        }
        // A caret is empty and sits between character spans.
        if (character && children.includes(character) && !String(character.textContent || "")) {
          return units(children.slice(0, children.indexOf(character)).filter(child => characterSet.has(child)).length);
        }
        return null;
      }
      // A changed prefix could give a repeated word the wrong context.
      return genericOffset(display, node, offset, source);
    }

    function clipContext(text, start, end, maximum) {
      if (text.length <= maximum) return text;
      const center = (start + end) / 2;
      const contentLimit = maximum - 24;
      const from = Math.max(0, Math.min(Math.floor(center - contentLimit / 2), text.length - contentLimit));
      const to = from + contentLimit;
      return `${from > 0 ? "[前文已截断]\n" : ""}${text.slice(from, to)}${to < text.length ? "\n[后文已截断]" : ""}`;
    }

    function contextAt(source, start, end) {
      const empty = { sentence: "", paragraph: "" };
      if (!source || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length || end <= start) return empty;
      const before = source.slice(0, start);
      const paragraphBreak = /\n[\t ]*\n/gu;
      let match;
      let paragraphStart = 0;
      while ((match = paragraphBreak.exec(before))) paragraphStart = match.index + match[0].length;
      const followingBreak = /\n[\t ]*\n/u.exec(source.slice(end));
      const paragraphEnd = followingBreak ? end + followingBreak.index : source.length;
      const paragraph = source.slice(paragraphStart, paragraphEnd);
      const relativeStart = start - paragraphStart;
      const relativeEnd = end - paragraphStart;
      let sentenceStart = 0;
      let sentenceEnd = paragraph.length;
      // Native English segmentation handles abbreviations more reliably than
      // punctuation alone. Keep a conservative fallback for older browsers.
      if (typeof window.SentenceCore?.sentenceRanges === "function") {
        const segments = window.SentenceCore.sentenceRanges(paragraph);
        const first = segments.find(part => part.end > relativeStart);
        const last = segments.find(part => part.end >= relativeEnd);
        if (first && last) { sentenceStart = first.start; sentenceEnd = last.end; }
      } else if (typeof Intl.Segmenter === "function") {
        const segments = Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(paragraph));
        const first = segments.find(part => part.index + part.segment.length > relativeStart);
        const last = segments.find(part => part.index + part.segment.length >= relativeEnd);
        if (first && last) {
          sentenceStart = first.index;
          sentenceEnd = last.index + last.segment.length;
        }
      } else {
        const boundaries = /[.!?]["'”’)]*\s+/gu;
        while ((match = boundaries.exec(paragraph))) {
          const boundary = match.index + match[0].length;
          if (boundary <= relativeStart) sentenceStart = boundary;
          if (boundary >= relativeEnd) { sentenceEnd = boundary; break; }
        }
      }
      const sentence = paragraph.slice(sentenceStart, sentenceEnd);
      return {
        sentence: clipContext(sentence, relativeStart - sentenceStart, relativeEnd - sentenceStart, 1200).trim(),
        paragraph: clipContext(paragraph, relativeStart, relativeEnd, 3000).trim(),
      };
    }

    function withContext(selected, raw, start, end, source) {
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const trimmedStart = Number.isInteger(start) ? start + leading : null;
      const trimmedEnd = Number.isInteger(end) ? end - trailing : null;
      const reliable = trimmedStart !== null && trimmedEnd !== null
        && source.slice(trimmedStart, trimmedEnd) === selected.text;
      const context = reliable ? contextAt(source, trimmedStart, trimmedEnd) : { sentence: "", paragraph: "" };
      return { ...selected, context, sourceText: reliable ? source : null, start: reliable ? trimmedStart : null, end: reliable ? trimmedEnd : null,
        key: `${selected.kind}:${trimmedStart !== null && trimmedEnd !== null ? `${trimmedStart}:${trimmedEnd}` : "unknown"}:${selected.text}:${JSON.stringify(context)}` };
    }

    function additionalSelection(selected, source) {
      const raw = String(selected.toString());
      const text = raw.trim();
      if (!text) return null;
      let range = null;
      try { range = selected.getRangeAt(0).cloneRange(); } catch { /* Context is optional when Range APIs are unavailable. */ }
      const referenceText = localReference(source);
      const rawStart = range ? genericOffset(source.display, range.startContainer, range.startOffset, referenceText) : null;
      const rawEnd = range ? genericOffset(source.display, range.endContainer, range.endOffset, referenceText) : null;
      const start = Number.isInteger(rawStart) ? rawStart + raw.length - raw.trimStart().length : null;
      const end = Number.isInteger(rawEnd) ? rawEnd - (raw.length - raw.trimEnd().length) : null;
      let context = { sentence: "", paragraph: "" };
      if (start !== null && end !== null && referenceText.slice(start, end) === text) {
        try {
          const mapped = source.mapRange?.(start, end);
          if (typeof mapped?.source === "string" && Number.isInteger(mapped.start) && Number.isInteger(mapped.end)
            && mapped.start >= 0 && mapped.end > mapped.start && mapped.end <= mapped.source.length) {
            // Grouping normalises the whitespace between sentences. The mapped
            // full-article range therefore need not equal the painted selection.
            context = contextAt(mapped.source, mapped.start, mapped.end);
          }
        } catch { /* Keep selected-text analysis when the source mapping fails. */ }
      }
      return { text, kind: "additional", range, area: source.area || source.display, start, end,
        sourceDisplay: source.display, localReference: referenceText, context,
        key: `additional:${sourceIdentity(source.display)}:${start}:${end}:${text}:${JSON.stringify(context)}` };
    }

    function listen(target, name, callback, options) {
      if (typeof target?.addEventListener === "function") target.addEventListener(name, callback, options);
    }

    function contains(parent, node) {
      if (!parent || !node) return false;
      if (parent === node) return true;
      if (typeof parent.contains === "function") return parent.contains(node);
      for (let ancestor = node.parentNode || node.parentElement; ancestor; ancestor = ancestor.parentNode || ancestor.parentElement) {
        if (ancestor === parent) return true;
      }
      return false;
    }

    function scopedSelection(selected, sourceDisplay) {
      if (contains(sourceDisplay, selected.anchorNode) && contains(sourceDisplay, selected.focusNode)) return selected;
      // A native triple-click may end at the next block's offset zero, after
      // the paragraph's rendered newline. Crop only when the excluded part is
      // whitespace; selections containing another group's text stay invalid.
      try {
        const range = selected.getRangeAt(0).cloneRange();
        const startsInside = contains(sourceDisplay, range.startContainer);
        const endsInside = contains(sourceDisplay, range.endContainer);
        if (!startsInside && !endsInside) return null;
        if (!startsInside) range.setStart(sourceDisplay, 0);
        if (!endsInside) range.setEnd(sourceDisplay, sourceDisplay.childNodes.length);
        const raw = range.toString();
        if (!raw.trim() || raw.trim() !== String(selected.toString()).trim()) return null;
        return { toString: () => raw, getRangeAt: () => range };
      } catch { return null; }
    }

    function selection() {
      if (!isActive()) return null;
      const selected = typeof window.getSelection === "function" ? window.getSelection() : null;
      if (selected && !selected.isCollapsed && selected.rangeCount) {
        for (const source of additionalSources()) {
          const scoped = scopedSelection(selected, source.display);
          if (scoped) return additionalSelection(scoped, source);
        }
      }
      const primary = isPrimaryActive() && selected && !selected.isCollapsed && selected.rangeCount ? scopedSelection(selected, display) : null;
      if (primary) {
        const raw = String(primary.toString());
        const text = raw.trim();
        if (text) {
          let range = null;
          try { range = primary.getRangeAt(0).cloneRange(); } catch { /* Some embedded environments omit Range APIs. */ }
          const source = reference();
          const start = range ? displayOffset(range.startContainer, range.startOffset, source) : null;
          const end = range ? displayOffset(range.endContainer, range.endOffset, source) : null;
          return withContext({ text, kind: "display", range, referenceText: source }, raw, start, end, source);
        }
        return null;
      }
      // A whitespace or outside document selection must never fall back to an
      // old English textarea selection which still happens to retain focus.
      if (selected && !selected.isCollapsed && selected.rangeCount) return null;
      // A display selection may coexist with the textarea retaining focus and an
      // old native selection. The visible document selection takes precedence.
      if (isPrimaryActive() && document.activeElement === input && Number.isInteger(input.selectionStart)
        && Number.isInteger(input.selectionEnd) && input.selectionEnd > input.selectionStart) {
        const value = String(input.value || "");
        const raw = value.slice(input.selectionStart, input.selectionEnd);
        const text = raw.trim();
        if (text) {
          const source = reference();
          const characters = Array.from(source);
          const start = characters.slice(0, Array.from(value.slice(0, input.selectionStart)).length).join("").length;
          const end = characters.slice(0, Array.from(value.slice(0, input.selectionEnd)).length).join("").length;
          return withContext({ text, kind: "input", referenceText: source }, raw, start, end, source);
        }
      }
      return null;
    }

    function hasPopupSelection() {
      const selected = typeof window.getSelection === "function" ? window.getSelection() : null;
      return Boolean(selected && !selected.isCollapsed && selected.rangeCount
        && contains(popup, selected.anchorNode) && contains(popup, selected.focusNode));
    }

    function isUsingPopup() {
      const selected = typeof window.getSelection === "function" ? window.getSelection() : null;
      // A new noncollapsed source/outside selection wins over a prior popup
      // interaction. A temporary collapsed range is normal while clicking a
      // button or beginning a drag to copy the panel's text.
      if (selected && !selected.isCollapsed && selected.rangeCount && !hasPopupSelection()) return false;
      return Boolean(current && !popup.hidden && (popupEngaged || contains(popup, document.activeElement)));
    }

    function close(dismiss = true) {
      revision += 1;
      if (dismiss) dismissedKey = selection()?.key || current?.key || null;
      current = null;
      popupEngaged = false;
      popup.hidden = true;
      popup.setAttribute?.("aria-busy", "false");
      hideAction();
    }

    function hideAction() {
      if (learnAction) learnAction.hidden = true;
      actionSelection = null;
      pressedSelection = null;
      actionPressed = false;
      actionPointerId = null;
      pressedButton = null;
    }

    function sentenceTarget(selected) {
      if (!sentenceButton || !sourceAvailable(selected) || !Number.isInteger(selected.start) || !Number.isInteger(selected.end)) return null;
      const source = selected.kind === "additional" ? selected.localReference : selected.sourceText;
      if (typeof source !== "string" || source.slice(selected.start, selected.end) !== selected.text) return null;
      const span = window.SentenceCore?.sentenceRanges?.(source)?.find(part => part.start <= selected.start && part.end >= selected.end);
      if (!span || span.text.length > MAX_TEXT_LENGTH || span.text === selected.text || !/[A-Za-z]/.test(span.text)) return null;
      if (selected.kind === "input") {
        const value = String(input.value || "");
        if (value.slice(span.start, span.end) !== span.text || typeof input.setSelectionRange !== "function") return null;
        return { ...span, input: true };
      }
      const sourceDisplay = selected.kind === "additional" ? selected.sourceDisplay : display;
      const range = sourceRange(sourceDisplay, span.start, span.end, selected.kind === "display" ? source : null);
      if (!range || range.toString().trim() !== span.text) return null;
      return { ...span, range };
    }

    function sourceRange(sourceDisplay, start, end, paintedSource) {
      try {
        const characters = paintedSource && Array.from(sourceDisplay.childNodes || []).filter(node =>
          node.classList?.contains("character") || String(node.className || "").split(/\s+/u).includes("character"));
        let nodes;
        if (characters?.length) {
          const referenceCharacters = Array.from(paintedSource);
          if (characters.length !== referenceCharacters.length) return null;
          let offset = 0;
          nodes = characters.map((node, index) => { const from = offset; offset += referenceCharacters[index].length;
            return { node, start: from, end: offset }; });
        } else {
          nodes = [];
          let offset = 0;
          const visit = node => {
            if (node.nodeType === 3) { const from = offset; offset += String(node.textContent || "").length; nodes.push({ node, start: from, end: offset }); }
            else for (const child of node.childNodes || []) visit(child);
          };
          visit(sourceDisplay);
        }
        const first = nodes.find(part => part.end > start);
        const last = nodes.find(part => part.end >= end && part.start < end);
        if (!first || !last) return null;
        const endpoint = (part, position) => {
          if (part.node.nodeType === 3) return { node: part.node, offset: position - part.start };
          if (position === part.start) return { node: part.node, offset: 0 };
          if (position === part.end) return { node: part.node, offset: part.node.childNodes.length };
          return null;
        };
        const from = endpoint(first, start), to = endpoint(last, end);
        if (!from || !to) return null;
        const range = document.createRange();
        range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
        return range;
      } catch { return null; }
    }

    function showAction(selected) {
      if (!learnAction || !learnButton || selectingWithMouse || !sourceAvailable(selected) || selected.key === dismissedKey) {
        hideAction();
        return;
      }
      actionSelection = { ...selected, actionAnchor: actionSelection?.key === selected.key ? actionSelection.actionAnchor : null };
      const target = sentenceTarget(selected);
      if (sentenceButton) {
        sentenceButton.hidden = !target;
        sentenceButton.title = "学习当前选区所在的完整句子";
      }
      learnButton.textContent = target ? `翻译与学习 · ${/^[A-Za-z]+(?:['’\-][A-Za-z]+)*$/u.test(selected.text) ? "单词" : "选区"}` : "翻译与学习";
      learnAction.setAttribute?.("data-split", String(Boolean(target)));
      learnAction.setAttribute?.("data-layout", touchInteraction ? "touch" : "floating");
      learnAction.hidden = false;
      positionAction();
    }

    function reset() {
      selectingWithMouse = false;
      selectionPoint = null;
      close(false);
      dismissedKey = null;
    }

    function setExpanded(expanded) {
      if (detailsContainer) detailsContainer.hidden = !expanded || !hasDetails;
      if (expandButton) {
        expandButton.hidden = !hasDetails;
        expandButton.textContent = expanded && hasDetails ? "收起学习" : "展开学习";
        expandButton.setAttribute?.("aria-expanded", String(Boolean(expanded && hasDetails)));
        if (detailsContainer?.id) expandButton.setAttribute?.("aria-controls", detailsContainer.id);
      }
      position();
    }

    function clearAnalysis() {
      if (typeLabel) typeLabel.textContent = "";
      if (briefContainer) briefContainer.textContent = "";
      if (detailsContainer) detailsContainer.textContent = "";
      hasDetails = false;
      setExpanded(false);
    }

    function renderRows(container, entries) {
      if (!container) return;
      container.textContent = "";
      for (const entry of entries) {
        const row = document.createElement("div");
        const label = document.createElement("span");
        const value = document.createElement("span");
        row.className = "selection-analysis-row";
        label.className = "selection-analysis-label";
        value.className = "selection-analysis-value";
        label.textContent = entry.label;
        value.textContent = entry.text;
        row.append(label, value);
        container.append(row);
      }
    }

    function renderAnalysis(analysis) {
      translationLabel.textContent = analysis.translation;
      if (typeLabel) typeLabel.textContent = TYPE_LABELS[analysis.type];
      // Reclassify on render so older cached responses also use the compact view.
      const brief = [];
      const details = [];
      for (const entry of analysis.brief) {
        const label = entry.label.replace(/[\s*_`#：:【】\[\]]/gu, "");
        (label === "核心用法" || label === "易错提醒" ? details : brief).push(entry);
      }
      details.push(...analysis.details);
      renderRows(briefContainer, brief);
      renderRows(detailsContainer, details);
      hasDetails = Boolean(detailsContainer && expandButton && details.length);
      setExpanded(false);
    }

    function viewport() {
      const visual = window.visualViewport;
      const width = visual?.width > 0 ? visual.width : window.innerWidth || document.documentElement?.clientWidth || 1024;
      const height = visual?.height > 0 ? visual.height : window.innerHeight || document.documentElement?.clientHeight || 768;
      const left = Number.isFinite(visual?.offsetLeft) ? visual.offsetLeft : 0;
      const top = Number.isFinite(visual?.offsetTop) ? visual.offsetTop : 0;
      return { width, height, left, top, right: left + width, bottom: top + height };
    }

    function positionAction() {
      if (!learnAction || !actionSelection) return;
      const view = viewport();
      if (!touchInteraction) {
        const selected = actionSelection;
        let rects = [];
        try { rects = Array.from(selected.range?.getClientRects?.() || []).filter(rect => rect.width && rect.height); } catch { /* Use the enclosing range below. */ }
        let rect = selected.rect;
        try { rect ||= selected.range?.getBoundingClientRect?.(); } catch { /* Use the source region when native geometry is unavailable. */ }
        if (rects.length) {
          if (!selected.actionAnchor) {
            let index = rects.length - 1;
            if (selectionPoint) {
              const distance = candidate => Math.hypot(Math.max(candidate.left - selectionPoint.x, 0, selectionPoint.x - candidate.right),
                Math.max(candidate.top - selectionPoint.y, 0, selectionPoint.y - candidate.bottom));
              index = rects.reduce((best, candidate, i) => distance(candidate) < distance(rects[best]) ? i : best, 0);
            }
            selected.actionAnchor = { index, offset: selectionPoint ? Math.max(0, Math.min(rects[index].width, selectionPoint.x - rects[index].left)) : 0 };
          }
          rect = rects[Math.min(selected.actionAnchor.index, rects.length - 1)];
        }
        if (selected.kind === "input" && selectionPoint) {
          const inputRect = input?.getBoundingClientRect?.();
          if (inputRect) {
            selected.actionAnchor ||= { inputX: Math.max(0, Math.min(inputRect.width, selectionPoint.x - inputRect.left)),
              inputY: Math.max(0, Math.min(inputRect.height, selectionPoint.y - inputRect.top)) };
            const left = inputRect.left + selected.actionAnchor.inputX;
            const top = inputRect.top + selected.actionAnchor.inputY;
            rect = { left, right: left, top, bottom: top, width: 0, height: 0 };
          }
        }
        rect ||= (selected.kind === "input" ? input : selected.area || area)?.getBoundingClientRect?.();
        if (!rect) return;
        const margin = 12, gap = 10;
        learnAction.hidden = rect.bottom < view.top || rect.top > view.bottom || rect.right < view.left || rect.left > view.right;
        if (learnAction.hidden) return;
        learnAction.style.width = "max-content";
        learnAction.style.maxWidth = `${Math.max(1, view.width - margin * 2)}px`;
        learnAction.style.maxHeight = `${Math.max(1, view.height - margin * 2)}px`;
        const bounds = learnAction.getBoundingClientRect?.() || {};
        const width = Math.min(bounds.width || 130, view.width - margin * 2);
        const height = bounds.height || 42;
        const anchorX = rect.left + (selected.actionAnchor?.offset || 0);
        const left = Math.max(view.left + margin, Math.min(anchorX, view.right - width - margin));
        let top = rect.bottom + gap + height <= view.bottom - margin ? rect.bottom + gap
          : Math.max(view.top + margin, rect.top - height - gap);
        const overlapsSelection = y => rects.some(part => left < part.right && left + width > part.left
          && y < part.bottom && y + height > part.top);
        if (rects.length && overlapsSelection(top)) {
          const above = rects.reduce((top, part) => Math.min(top, part.top), Infinity) - height - gap;
          const below = rects.reduce((bottom, part) => Math.max(bottom, part.bottom), -Infinity) + gap;
          const alternatives = [above, below].filter(y => y >= view.top + margin && y + height <= view.bottom - margin && !overlapsSelection(y));
          if (alternatives.length) top = alternatives.sort((a, b) => Math.abs(a - rect.top) - Math.abs(b - rect.top))[0];
        }
        learnAction.style.left = `${Math.round(left)}px`;
        learnAction.style.top = `${Math.round(top)}px`;
        return;
      }
      learnAction.hidden = false;
      const width = Math.max(1, Math.min(340, view.width - 24));
      learnAction.style.width = `${Math.round(width)}px`;
      learnAction.style.maxWidth = `${Math.max(1, view.width - 24)}px`;
      learnAction.style.maxHeight = `${Math.max(1, Math.floor(view.height - 24))}px`;
      const height = learnAction.getBoundingClientRect?.().height || 72;
      learnAction.style.left = `${Math.round(view.left + (view.width - width) / 2)}px`;
      learnAction.style.top = `${Math.round(Math.max(view.top + 12, view.bottom - height - 12))}px`;
    }

    function position() {
      if (popup.hidden || !current) return;
      let rect = current.rect || null;
      try { rect = current.range?.getBoundingClientRect() || rect; } catch { /* Fall back to the input region. */ }
      if (!rect || (!rect.width && !rect.height && rect.top === 0 && rect.left === 0)) {
        rect = (current.kind === "input" ? input : current.area || area)?.getBoundingClientRect?.();
      }
      if (!rect) return;
      const view = viewport();
      const mobile = view.width <= 600;
      popup.style.width = `${Math.max(1, Math.min(mobile ? view.width - 24 : 420, view.width - 24))}px`;
      const maximumHeight = Math.max(1, Math.floor(mobile ? Math.min(view.height * .65, view.height - 24) : view.height - 24));
      popup.style.maxHeight = `${maximumHeight}px`;
      const bounds = popup.getBoundingClientRect?.() || {};
      const width = Math.min(bounds.width || 420, view.width - 24);
      const height = Math.min(bounds.height || 180, maximumHeight);
      const margin = 12;
      const left = mobile ? view.left + margin : Math.max(view.left + margin, Math.min(rect.left, view.right - width - margin));
      const below = rect.bottom + 10;
      const top = mobile ? Math.max(view.top + margin, view.bottom - height - margin)
        : below + height <= view.bottom - margin && below >= view.top + margin ? below
          : Math.max(view.top + margin, Math.min(rect.top - height - 10, view.bottom - height - margin));
      popup.style.left = `${Math.round(left)}px`;
      popup.style.top = `${Math.round(top)}px`;
    }

    function errorMessage(status) {
      if (status === 401 || status === 403) return "学习分析密钥未通过验证，请检查本地 .env 配置后重试。";
      if (status === 402) return "学习分析账户余额不足，请检查账户后重试。";
      if (status === 429) return "学习分析请求较多，请稍后重试。";
      if (status === 503) return "学习分析服务尚未配置好，请检查本地 .env 配置后重试。";
      return "学习分析暂时不可用，请确认本地翻译服务已启动，再点击重试。";
    }

    function validateAnalysis(data) {
      const analysis = data?.analysis;
      const validText = (value, limit) => typeof value === "string" && Boolean(value.trim()) && value.length <= limit;
      if (!analysis && validText(data?.fallbackText, 16000)) return { fallbackText: data.fallbackText.trim() };
      const validRows = rows => Array.isArray(rows) && rows.length > 0 && rows.length <= 20
        && rows.every(row => row && validText(row.label, 100) && validText(row.text, 16000));
      if (!analysis || !Object.prototype.hasOwnProperty.call(TYPE_LABELS, analysis.type)
        || !validText(analysis.translation, 16000) || !validRows(analysis.brief) || !validRows(analysis.details)) {
        throw new Error("没有收到有效学习分析，请重试。");
      }
      const rows = items => items.map(item => ({ label: item.label.trim(), text: item.text.trim() }));
      return { type: analysis.type, translation: analysis.translation.trim(), brief: rows(analysis.brief), details: rows(analysis.details) };
    }

    function request(selected) {
      const context = selected.context || { sentence: "", paragraph: "" };
      const key = JSON.stringify([selected.text, context.sentence, context.paragraph]);
      if (cache.has(key)) {
        const cached = cache.get(key);
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const promise = (async () => {
        if (window.ZijianAuth && !window.ZijianAuth.hasAccess() && !await window.ZijianAuth.ensureAccess()) {
          throw new Error("当前没有可用练习时长，请领取新手券或兑换时长券。已选文字会保留。");
        }
        let response;
        try {
          response = await window.fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: selected.text, context }),
          });
        } catch { throw new Error(errorMessage()); }
        if (!response.ok) {
          let data;
          try { data = await response.json(); } catch { /* The HTTP status supplies the fallback. */ }
          throw new Error(typeof data?.error === "string" && data.error.trim().length > 0 && data.error.length <= 400
            ? data.error.trim() : errorMessage(response.status));
        }
        let data;
        try { data = await response.json(); } catch { throw new Error("学习分析结果格式异常，请重试。"); }
        return validateAnalysis(data);
      })();
      cache.set(key, promise);
      while (cache.size > MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
      const evict = () => { if (cache.get(key) === promise) cache.delete(key); };
      promise.then(result => { if (result.fallbackText) evict(); }, evict);
      return promise;
    }

    async function translate(selected) {
      if (!sourceAvailable(selected) || !/[A-Za-z]/.test(selected.text) || selected.key === dismissedKey) return;
      hideAction();
      current = selected;
      const requestRevision = ++revision;
      popup.hidden = false;
      popupEngaged = popupEngaged || contains(popup, document.activeElement);
      if (document.activeElement === retryButton || document.activeElement === expandButton) {
        closeButton.focus?.({ preventScroll: true });
      }
      sourceLabel.textContent = selected.text;
      translationLabel.textContent = "";
      clearAnalysis();
      retryButton.hidden = true;
      popup.setAttribute?.("aria-busy", "false");
      if (selected.text.length > MAX_TEXT_LENGTH) {
        statusLabel.textContent = `一次最多分析 ${MAX_TEXT_LENGTH} 个字符，请缩小选中范围。`;
        position();
        return;
      }
      if (window.location?.protocol === "file:") {
        statusLabel.textContent = "请先双击“启动翻译.cmd”，再打开 http://127.0.0.1:4173 使用选区学习分析。";
        position();
        return;
      }
      statusLabel.textContent = "正在分析与翻译…";
      popup.setAttribute?.("aria-busy", "true");
      position();
      const stillCurrent = () => revision === requestRevision && current?.key === selected.key
        && (hasPopupSelection() || isUsingPopup() || (selected.kind === "snapshot" ? !selection() || selection()?.text === selected.text
          : selection()?.key === selected.key)) && sourceAvailable(selected) && !popup.hidden;
      try {
        const analysis = await request(selected);
        if (!stillCurrent()) return;
        if (analysis.fallbackText) {
          translationLabel.textContent = analysis.fallbackText;
          statusLabel.textContent = "当前以简洁文本展示，可重试获取完整学习卡片。";
          retryButton.hidden = false;
        } else {
          renderAnalysis(analysis);
          statusLabel.textContent = "";
        }
      } catch (error) {
        if (!stillCurrent()) return;
        statusLabel.textContent = error.message;
        retryButton.hidden = false;
      } finally {
        if (stillCurrent()) {
          popup.setAttribute?.("aria-busy", "false");
          position();
        }
      }
    }

    function inspect() {
      // Focusing a touch button can collapse the native selection before click.
      // Keep its complete source/context snapshot until that gesture finishes.
      if (actionPressed && pressedSelection && sourceAvailable(pressedSelection)) return;
      if (current && !sourceAvailable(current)) {
        reset();
        return;
      }
      // The floating panel is ordinary selectable text. Copying its source or
      // Chinese result must not dismiss it or start another translation.
      if (hasPopupSelection()) { hideAction(); return; }
      const selected = selection();
      if (!selected && isUsingPopup()) { hideAction(); position(); return; }
      if (!selected || !/[A-Za-z]/.test(selected.text)) {
        close(false);
        dismissedKey = null;
        return;
      }
      if (current?.key === selected.key && !popup.hidden) {
        current = selected;
        hideAction();
        position();
        return;
      }
      // Selecting text alone never opens a panel or starts a paid request.
      if (current) close(false);
      showAction(selected);
    }

    function translateSelection(snapshot) {
      if (!isActive()) return;
      const live = selection();
      let selected = live;
      if (snapshot && typeof snapshot.text === "string") {
        const text = snapshot.text.trim();
        selected = live?.text === text ? { ...live, rect: snapshot.rect }
          : { text, key: `snapshot:${text}`, kind: "snapshot", rect: snapshot.rect, context: { sentence: "", paragraph: "" } };
      }
      dismissedKey = null;
      if (!selected || !/[A-Za-z]/.test(selected.text)) {
        close(false);
        return;
      }
      return translate(selected);
    }

    listen(document, "selectionchange", inspect);
    listen(input, "select", inspect);
    // Native word/paragraph selection stays local. Only the explicit action
    // below can request AI, so a third click can still extend a word to a paragraph.
    listen(display, "dblclick", inspect);
    listen(input, "dblclick", inspect);
    listen(document, "dblclick", inspect);
    listen(document, "pointerdown", (event) => {
      if (contains(learnAction, event.target)) return;
      if (touchPointer(event)) touchInteraction = true;
      else if (event.pointerType === "mouse") touchInteraction = false;
      if (contains(popup, event.target)) {
        popupEngaged = Boolean(current && !popup.hidden);
        return;
      }
      popupEngaged = false;
      const sources = additionalSources();
      const onSource = (isPrimaryActive() && (contains(display, event.target) || contains(input, event.target)))
        || sources.some(source => contains(source.display, event.target));
      selectingWithMouse = onSource && !touchPointer(event) && (event.button === undefined || event.button === 0);
      selectionPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? { x: event.clientX, y: event.clientY } : null;
      hideAction();
      if ((isPrimaryActive() && contains(area, event.target))
        || sources.some(candidate => contains(candidate.area || candidate.display, event.target))) {
        dismissedKey = null;
      } else close();
    });
    listen(document, "pointerup", (event) => {
      if (selectingWithMouse) {
        selectingWithMouse = false;
        selectionPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? { x: event.clientX, y: event.clientY } : selectionPoint;
        inspect();
      }
      if (!actionPressed || (actionPointerId !== null && event.pointerId !== undefined && event.pointerId !== actionPointerId)) return;
      const button = pressedButton || learnButton;
      const bounds = button?.getBoundingClientRect?.();
      const hasPoint = bounds?.width > 0 && bounds?.height > 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
      const insideBounds = !hasPoint || (event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom);
      if (!contains(button, event.target) || !insideBounds) close();
    });
    listen(document, "pointercancel", (event) => {
      selectingWithMouse = false;
      if (actionPressed && actionPointerId !== null && event.pointerId !== undefined && event.pointerId !== actionPointerId) return;
      actionPressed = false;
      pressedSelection = null;
      actionPointerId = null;
      pressedButton = null;
      if (touchPointer(event)) inspect();
      else close(false);
    });
    listen(document, "keydown", (event) => {
      if (event.key === "Escape") close();
      else if (event.shiftKey && ((isPrimaryActive() && contains(area, event.target))
        || additionalSources().some(source => contains(source.area || source.display, event.target)))) dismissedKey = null;
    });
    listen(input, "input", () => close());
    listen(input, "beforeinput", () => close());
    listen(input, "compositionstart", () => close());
    const reposition = () => { position(); positionAction(); };
    listen(window, "resize", reposition);
    listen(window, "scroll", reposition, true);
    listen(window.visualViewport, "resize", reposition);
    listen(window.visualViewport, "scroll", reposition);
    listen(retryButton, "pointerdown", (event) => { if (!touchPointer(event)) event.preventDefault(); });
    listen(closeButton, "pointerdown", (event) => { if (!touchPointer(event)) event.preventDefault(); });
    const pressAction = button => event => {
      if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
      const selected = selection() || actionSelection;
      if (!selected || !/[A-Za-z]/.test(selected.text) || !sourceAvailable(selected)) return;
      pressedSelection = selected;
      actionPressed = true;
      actionPointerId = event.pointerId ?? null;
      pressedButton = button;
      // Mouse focus must not collapse the source range. Touch keeps its native
      // behavior and uses the saved snapshot when the platform collapses it.
      if (!touchPointer(event)) event.preventDefault();
    };
    listen(learnButton, "pointerdown", pressAction(learnButton));
    listen(sentenceButton, "pointerdown", pressAction(sentenceButton));
    listen(assistantButton, "pointerdown", pressAction(assistantButton));
    function actionSnapshot(button) {
      const selected = pressedSelection || actionSelection;
      const live = selection();
      const native = window.getSelection?.();
      const changed = native && !native.isCollapsed && native.rangeCount && live?.key !== selected?.key;
      if (!selected || (pressedButton && pressedButton !== button) || changed || !/[A-Za-z]/.test(selected.text) || !sourceAvailable(selected)) {
        hideAction();
        return null;
      }
      return selected;
    }
    listen(learnButton, "click", () => {
      const selected = actionSnapshot(learnButton);
      if (!selected) return;
      dismissedKey = null;
      popupEngaged = true;
      return translate(selected);
    });
    listen(assistantButton, "click", () => {
      const selected = actionSnapshot(assistantButton);
      if (!selected || typeof onAddToAssistant !== "function") return;
      close(false);
      dismissedKey = selected.key;
      return onAddToAssistant(selected);
    });
    listen(sentenceButton, "click", () => {
      const selected = actionSnapshot(sentenceButton);
      if (!selected) return;
      const target = sentenceTarget(selected);
      if (!target) { hideAction(); return; }
      if (target.input) {
        input.focus?.({ preventScroll: true });
        input.setSelectionRange(target.start, target.end);
      } else {
        const native = window.getSelection?.();
        if (!native?.removeAllRanges || !native.addRange) { hideAction(); return; }
        native.removeAllRanges(); native.addRange(target.range);
      }
      const expanded = selection();
      if (!expanded || expanded.text !== target.text || !sourceAvailable(expanded)) { hideAction(); return; }
      dismissedKey = null;
      popupEngaged = true;
      return translate(expanded);
    });
    listen(expandButton, "click", () => setExpanded(detailsContainer?.hidden));
    listen(retryButton, "click", () => {
      const selected = selection() || (hasPopupSelection() || isUsingPopup() ? current : null);
      if (selected && selected.key === current?.key) return translate(selected);
    });
    listen(closeButton, "click", () => close());
    popup.hidden = true;
    hideAction();
    clearAnalysis();
    return { close, reset, prepareForInput: () => close(), translateSelection,
      getSelectionForAssistant: () => { const selected = selection() || actionSelection; return sourceAvailable(selected) && /[A-Za-z]/.test(selected.text) ? selected : null; } };
  }

  window.SelectionTranslation = { create };
})();
