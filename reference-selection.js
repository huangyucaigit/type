(() => {
  "use strict";

  function create({ input, display, area, isActive = () => true, onResumeInput = () => {} } = {}) {
    const doc = display?.ownerDocument || globalThis.document;
    const view = doc?.defaultView || globalThis.window;
    const listeners = [];
    let pointerGesture = null;
    let disposed = false;

    function active() {
      return !disposed && Boolean(isActive());
    }

    function inside(node) {
      if (!node || !display) return false;
      if (typeof display.contains === "function") return display.contains(node);
      for (let current = node; current; current = current.parentNode || current.parentElement) {
        if (current === display) return true;
      }
      return false;
    }

    function selection() {
      try {
        return typeof view?.getSelection === "function" ? view.getSelection() : doc?.getSelection?.();
      } catch {
        return null;
      }
    }

    function documentRange() {
      const current = selection();
      if (!current?.rangeCount || typeof current.getRangeAt !== "function") return null;
      try {
        return current.getRangeAt(0);
      } catch {
        return null;
      }
    }

    function sourceRange() {
      const range = documentRange();
      return range && inside(range.startContainer) && inside(range.endContainer) ? range : null;
    }

    function collapsed(range) {
      return range.collapsed ?? (range.startContainer === range.endContainer && range.startOffset === range.endOffset);
    }

    function nativeRange() {
      const length = String(input?.value ?? "").length;
      const clamp = value => Math.min(length, Math.max(0, Number.isFinite(value) ? value : length));
      return {
        start: clamp(input?.selectionStart),
        end: clamp(input?.selectionEnd),
        direction: input?.selectionDirection === "backward" ? "backward" : "forward",
      };
    }

    let previousNativeRange = nativeRange();

    // A textarea counts UTF-16 code units. Range.toString().length uses the
    // same units, including when each painted span contains a whole emoji.
    function offset(node, endOffset) {
      if (typeof doc?.createRange !== "function") return null;
      try {
        const prefix = doc.createRange();
        prefix.selectNodeContents(display);
        prefix.setEnd(node, endOffset);
        return prefix.toString().length;
      } catch {
        return null;
      }
    }

    function offsets(range) {
      if (!range) return null;
      const start = offset(range.startContainer, range.startOffset);
      const end = offset(range.endContainer, range.endOffset);
      if (start === null || end === null) return null;
      const current = selection();
      const backward = !collapsed(range) && current?.anchorNode === range.endContainer && current?.anchorOffset === range.endOffset;
      return { start, end, direction: backward ? "backward" : "forward" };
    }

    function applyNativeRange(range) {
      if (typeof input?.setSelectionRange !== "function") return;
      const length = String(input.value ?? "").length;
      input.setSelectionRange(Math.min(range.start, length), Math.min(range.end, length), range.direction);
    }

    function setSelecting(selected) {
      area?.classList?.toggle("is-source-selecting", selected);
    }

    function clearSourceRange() {
      if (sourceRange()) selection()?.removeAllRanges?.();
      setSelecting(false);
    }

    function clear() {
      pointerGesture = null;
      clearSourceRange();
      previousNativeRange = nativeRange();
    }

    function resume(range) {
      // Clear the document selection before focusing the textarea, so clearing
      // source text can never discard the textarea's native edit selection.
      onResumeInput();
      clearSourceRange();
      input?.focus?.({ preventScroll: true });
      applyNativeRange(range);
      previousNativeRange = nativeRange();
    }

    function pointerDown(event) {
      if (!active() || event.isPrimary === false || (event.button !== undefined && event.button !== 0) || !inside(event.target)) return;
      pointerGesture = {
        id: event.pointerId,
        direct: event.pointerType === "touch" || event.pointerType === "pen",
        startedAt: pointerTime(event),
        x: event.clientX,
        y: event.clientY,
        moved: false,
        contextMenu: false,
      };
      previousNativeRange = nativeRange();
      // Native touch selection handles and long-press menus need their default
      // pointer behavior, even when the gesture begins inside an existing range.
      if (pointerGesture.direct) return;
      const range = sourceRange();
      if (!range || collapsed(range) || typeof range.getClientRects !== "function") return;
      // Preserve a whole dragged phrase through the two clicks of a double
      // click. Otherwise the browser would reduce it to a single word first.
      const withinSelection = Array.from(range.getClientRects()).some(rect =>
        rect.width !== 0 && rect.height !== 0 &&
        event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom
      );
      if (withinSelection) event.preventDefault();
    }

    function pointerTime(event) {
      return Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
    }

    function samePointer(event) {
      return pointerGesture && (pointerGesture.id === undefined || event.pointerId === undefined || pointerGesture.id === event.pointerId);
    }

    function pointerMove(event) {
      if (!samePointer(event) || !pointerGesture.direct) return;
      const dx = event.clientX - pointerGesture.x;
      const dy = event.clientY - pointerGesture.y;
      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) >= 10) pointerGesture.moved = true;
    }

    function contextMenu() {
      if (pointerGesture?.direct) pointerGesture.contextMenu = true;
    }

    function pointerCancel(event) {
      if (samePointer(event)) pointerGesture = null;
    }

    function pointerUp(event) {
      if (!samePointer(event)) return;
      const gesture = pointerGesture;
      pointerGesture = null;
      if (!active() || (event.button !== undefined && event.button !== 0)) return;
      const range = sourceRange();
      if (range && !collapsed(range)) {
        if (gesture.direct) {
          // Safari may finish establishing its range after pointerup. Neither
          // textarea.setSelectionRange nor focus should replace that native
          // range while the user is moving the system selection handles.
          setSelecting(true);
          return;
        }
        const selected = offsets(range);
        const length = String(input?.value ?? "").length;
        applyNativeRange(selected && selected.end <= length ? selected : previousNativeRange);
        display?.focus?.({ preventScroll: true });
        setSelecting(true);
        return;
      }
      // A drag that includes surrounding page content remains a normal page
      // selection; it must not silently become an edit of the typing draft.
      const outsideRange = documentRange();
      if (outsideRange && !collapsed(outsideRange)) {
        setSelecting(false);
        return;
      }
      // A short, still tap enters typing. A long press or scroll leaves focus
      // untouched, including when the browser has not exposed its range yet.
      if (gesture.direct && (gesture.moved || gesture.contextMenu || pointerTime(event) - gesture.startedAt >= 300)) return;
      const selected = offsets(range);
      const length = String(input?.value ?? "").length;
      const caret = selected ? Math.min(selected.start, length) : previousNativeRange.end;
      resume({ start: caret, end: caret, direction: "forward" });
    }

    function selectAll(event) {
      if (typeof doc?.createRange !== "function") return;
      const current = selection();
      if (!current?.removeAllRanges || !current?.addRange) return;
      event.preventDefault();
      previousNativeRange = nativeRange();
      const range = doc.createRange();
      range.selectNodeContents(display);
      current.removeAllRanges();
      current.addRange(range);
      setSelecting(!collapsed(range));
    }

    function keyDown(event) {
      if (!active() || event.defaultPrevented) return;
      const key = String(event.key ?? "");
      const lower = key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      const altGraph = event.getModifierState?.("AltGraph");
      const compositionKey = event.isComposing || event.keyCode === 229 || ["Process", "Unidentified", "Dead"].includes(key);
      // Alt+arrows are browser navigation, while AltGraph may generate text.
      if (event.altKey && !altGraph && !compositionKey) return;
      if (command && !event.altKey && lower === "a") {
        selectAll(event);
        return;
      }
      if (command && lower === "c") return;
      const range = sourceRange();
      const selected = offsets(range);
      const length = String(input?.value ?? "").length;
      const editableSelection = selected && selected.end <= length;
      // Cutting untyped reference text must not cut an unrelated draft range.
      if (command && lower === "x" && !editableSelection) return;
      const editingKey = ["Enter", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key);
      const editCommand = command && !event.altKey && ["v", "x", "z", "y"].includes(lower);
      const printable = Array.from(key).length === 1 && ((!command && !event.altKey) || altGraph);
      if (!editingKey && !editCommand && !printable && !compositionKey) return;

      // Keep the original trusted keyboard event and its native default action.
      // In particular, never assign value/setRangeText or synthesize text: those
      // approaches lose browser undo history and composing-input behavior.
      resume(editableSelection ? selected : range ? previousNativeRange : nativeRange());
    }

    function selectionChanged() {
      const range = active() ? sourceRange() : null;
      setSelecting(Boolean(range && !collapsed(range)));
    }

    function listen(target, name, handler, options) {
      if (typeof target?.addEventListener !== "function") return;
      target.addEventListener(name, handler, options);
      listeners.push(() => target.removeEventListener?.(name, handler, options));
    }

    listen(display, "pointerdown", pointerDown);
    listen(doc, "pointermove", pointerMove);
    listen(doc, "pointerup", pointerUp);
    listen(doc, "pointercancel", pointerCancel);
    listen(display, "contextmenu", contextMenu);
    listen(display, "keydown", keyDown, true);
    listen(doc, "selectionchange", selectionChanged);
    return {
      clear,
      destroy() {
        clear();
        disposed = true;
        listeners.forEach(remove => remove());
      },
    };
  }

  window.ReferenceSelection = { create };
})();
