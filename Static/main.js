// DyslexiLens Ergonomic Workspace Controller (Muted Sage Green Edition)

document.addEventListener('DOMContentLoaded', () => {
  const previewBox = document.getElementById('reading-preview');
  const previewWrapper = document.querySelector('.reading-preview-wrapper');
  const rulerToggle = document.getElementById('toggle-ruler');
  const rulerElement = document.getElementById('reading-ruler');

  // 1. Precise Visual Line Detection via Native Range & getClientRects() API
  // Keeps text 100% natural and undivided with consistent paragraph flow and zero reflow jitter.
  function getLineRectAtPoint(cursorX, cursorY) {
    if (!previewBox) return null;

    // First try standard caretRangeFromPoint / caretPositionFromPoint to identify exact text position
    let caretRange = null;
    if (document.caretRangeFromPoint) {
      caretRange = document.caretRangeFromPoint(cursorX, cursorY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(cursorX, cursorY);
      if (pos && pos.offsetNode) {
        caretRange = document.createRange();
        caretRange.setStart(pos.offsetNode, pos.offset);
        caretRange.collapse(true);
      }
    }

    // Get all natural visual line bounding boxes from the text content
    const fullRange = document.createRange();
    fullRange.selectNodeContents(previewBox);
    const rawRects = Array.from(fullRange.getClientRects()).filter(r => r.width > 2 && r.height > 2);

    if (rawRects.length === 0) return null;

    // Merge inline segment rects that belong to the exact same visual line row
    const visualLines = [];
    rawRects.forEach(rect => {
      const existingLine = visualLines.find(l => Math.abs(l.top - rect.top) < 6);
      if (existingLine) {
        existingLine.top = Math.min(existingLine.top, rect.top);
        existingLine.bottom = Math.max(existingLine.bottom, rect.bottom);
        existingLine.left = Math.min(existingLine.left, rect.left);
        existingLine.right = Math.max(existingLine.right, rect.right);
        existingLine.width = existingLine.right - existingLine.left;
        existingLine.height = existingLine.bottom - existingLine.top;
      } else {
        visualLines.push({
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height
        });
      }
    });

    // Check if caretRange gives us the precise line directly
    if (caretRange) {
      const caretRect = caretRange.getBoundingClientRect();
      if (caretRect && caretRect.height > 0) {
        const directMatch = visualLines.find(l => caretRect.top >= l.top - 4 && caretRect.bottom <= l.bottom + 4);
        if (directMatch) return directMatch;
      }
    }

    // Match visual line by cursor Y coordinate
    let matchedLine = visualLines.find(l => cursorY >= l.top - 2 && cursorY <= l.bottom + 2);

    if (!matchedLine) {
      // Find closest vertical line
      let minDiff = Infinity;
      visualLines.forEach(l => {
        const midY = (l.top + l.bottom) / 2;
        const diff = Math.abs(cursorY - midY);
        if (diff < minDiff) {
          minDiff = diff;
          matchedLine = l;
        }
      });
    }

    return matchedLine;
  }

  // Shared hook: re-runs the collision-proof line zoom with FRESH measurements
  // whenever a slider changes (the safe zoom amount depends on live slider values).
  let applyZoomSettings = () => {};

  // 2. Reading Line Guide (Ruler) + Collision-Proof Measurement-Based Line Zoom
  //
  // The zoom is re-measured on EVERY hover (never cached from page load):
  //   1. Measure the hovered visual line's real rendered width (getBoundingClientRect).
  //   2. Measure the free space to the container's right padding edge:
  //      availableSpace = containerWidth - lineWidth - rightPadding.
  //   3. safeScale = 1 + (availableSpace / lineWidth), hard-capped at 1.05.
  //   4. Apply 90% of that calculated max as a safety buffer (never below 1).
  // A short line therefore gets the full subtle ~5% zoom, while a long line that
  // already reaches the right edge gets ~1.0 (no zoom) -> zero clipping, ever.
  if (rulerToggle && rulerElement && previewBox && previewWrapper) {
    const savedState = localStorage.getItem('dyslexilens_ruler');
    rulerToggle.checked = savedState === 'true';
    rulerElement.style.display = 'none';

    const ZOOM_HARD_CAP = 1.05;     // Never zoom more than 5%, even with lots of room
    const SAFETY_BUFFER = 0.9;      // Apply 90% of the calculated max as a safety margin
    const MIN_MEASURABLE_WIDTH = 8; // Skip blank/artifact lines that cannot be measured

    let lastMatchedTop = null;
    let lastPointer = null;

    /**
     * REUSABLE MEASUREMENT FUNCTION.
     * Calculates the MAXIMUM safe zoom scale for one specific visual line at this
     * exact moment. Must re-run on every hover and after every slider change,
     * because the safe amount depends on the live font-size / letter-spacing /
     * line-spacing values and the line's current rendered width.
     *
     * @param {DOMRect} lineRect      Rect of the hovered line, measured at scale 1.
     * @param {DOMRect} containerRect Rect of the reading sandbox container.
     * @returns {number} Maximum safe zoom scale, capped at 1.05.
     */
    function measureSafeZoomScale(lineRect, containerRect) {
      const lineWidth = lineRect.width;
      if (lineWidth < MIN_MEASURABLE_WIDTH) return 1;

      // Available width = container width - current line width - right padding
      const boxStyle = getComputedStyle(previewBox);
      const rightPadding = parseFloat(boxStyle.paddingRight) || 0;
      const containerRightEdge = containerRect.right - rightPadding;
      const availableSpace = containerRightEdge - lineRect.right;

      if (availableSpace <= 0) return 1; // No room at all -> absolutely no zoom

      // MAXIMUM safe scale for THIS line, at THIS moment
      const calculatedMax = 1 + (availableSpace / lineWidth);
      return Math.min(calculatedMax, ZOOM_HARD_CAP);
    }

    // --- Temporary whole-line character span -----------------------------------
    // CSS transforms don't apply to raw inline text, so the HOVERED LINE's exact
    // characters are wrapped in a temporary inline-block span. The span must hold
    // exactly one visual line's worth of text: if it swallowed previous lines too,
    // the inline-block would re-wrap internally and destroy the layout. The line's
    // start/end offsets are therefore located by binary search over per-character
    // rects. Scaling about its LEFT edge means it can only grow rightward into the
    // measured free space: it can never push neighbours or clip at the border.
    let zoomedSpan = null;

    function clearLineZoom() {
      if (!zoomedSpan) return;
      const parent = zoomedSpan.parentNode;
      if (parent) {
        while (zoomedSpan.firstChild) parent.insertBefore(zoomedSpan.firstChild, zoomedSpan);
        zoomedSpan.remove();
        parent.normalize(); // Merge the text nodes back into one
      }
      zoomedSpan = null;
    }

    /** Top edge (viewport Y) of the character at text offset k, or null. */
    function charTopAt(node, k) {
      const range = document.createRange();
      if (k >= node.length) {
        range.setStart(node, node.length);
        range.setEnd(node, node.length);
      } else {
        range.setStart(node, k);
        range.setEnd(node, k + 1);
      }
      const rects = range.getClientRects();
      return rects.length > 0 ? rects[0].top : null;
    }

    /** Smallest offset whose character renders on the hovered line (binary search;
        char rect tops are non-decreasing within a wrapped text node). */
    function findLineStartOffset(node, caretOffset, lineTop) {
      const t0 = charTopAt(node, 0);
      if (t0 === null || t0 >= lineTop - 1) return 0;
      let lo = 0, hi = caretOffset; // invariant: top(lo) < line, top(hi) >= line
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        const t = charTopAt(node, mid);
        if (t === null || t < lineTop - 1) lo = mid; else hi = mid;
      }
      return hi;
    }

    /** Offset just past the hovered line's last character (binary search). */
    function findLineEndOffset(node, caretOffset, lineBottom) {
      const isLaterLine = (k) => {
        const t = charTopAt(node, k);
        return t !== null && t >= lineBottom + 1;
      };
      if (isLaterLine(caretOffset)) return caretOffset; // paranoia fallback
      let lo = caretOffset, hi = node.length; // invariant: !later(lo)
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (isLaterLine(mid)) hi = mid; else lo = mid;
      }
      return hi;
    }

    function wrapLineSegment(cursorX, cursorY, line) {
      let node = null;
      let offset = 0;

      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(cursorX, cursorY);
        if (range) { node = range.startContainer; offset = range.startOffset; }
      } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(cursorX, cursorY);
        if (pos) { node = pos.offsetNode; offset = pos.offset; }
      }
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      if (node.parentElement && node.parentElement.closest('.line-zoom-seg')) return null;

      const text = node.textContent || '';
      if (!text.trim() || offset > text.length) return null;
      if (!line || !(line.height > 0)) return null;

      // Locate the hovered line's exact character range inside this text node
      const start = findLineStartOffset(node, offset, line.top);
      const end = findLineEndOffset(node, offset, line.bottom);
      const segText = text.slice(start, end);
      if (end <= start || !segText.trim()) return null;

      // Split the node into [before][SPAN][after] so the span holds exactly one line
      const span = document.createElement('span');
      span.className = 'line-zoom-seg';
      const tail = document.createTextNode(text.slice(end));
      node.textContent = text.slice(0, start);
      node.parentNode.insertBefore(span, node.nextSibling);
      span.textContent = segText;
      if (tail.length > 0) node.parentNode.insertBefore(tail, span.nextSibling);
      zoomedSpan = span;
      return span;
    }

    /**
     * Apply the collision-proof zoom for the currently hovered visual line.
     * Pass 1: wrap exactly the hovered line's characters and measure the real
     *         rendered line width at scale 1.
     * Pass 2: calculate the maximum safe scale for this line, right now.
     * Pass 3: apply 90% of that max (safety buffer), scaling about the left edge.
     */
    function applyMeasurementBasedZoom(cursorX, cursorY, line) {
      // Never mutate text nodes while the sandbox is focused (editing mode):
      // splitting the caret's text node would make the caret jump while typing.
      if (document.activeElement === previewBox) {
        clearLineZoom();
        return;
      }
      clearLineZoom();
      if (!line) return;

      const span = wrapLineSegment(cursorX, cursorY, line);
      if (!span) return;

      // Pass 1: measure the real rendered line width (transform temporarily off)
      span.style.transform = 'none';
      const lineRect = span.getBoundingClientRect();
      const containerRect = previewBox.getBoundingClientRect();

      // Pass 2: maximum safe scale for this specific line, at this specific moment
      const maxSafeScale = measureSafeZoomScale(lineRect, containerRect);

      // Pass 3: apply the safe scale, keeping a 10% safety buffer of the remaining
      // zoom room (i.e. use 90% of the calculated max zoom amount, never below 1).
      const safeScale = Math.min(ZOOM_HARD_CAP, Math.max(1, 1 + (maxSafeScale - 1) * SAFETY_BUFFER));
      if (safeScale > 1.001) {
        span.style.transform = `scaleX(${safeScale})`;
      }
    }

    // Re-apply the current zoom with FRESH measurements (used after slider changes,
    // so the safe zoom amount is recalculated whenever font/spacing values move).
    applyZoomSettings = function () {
      if (!rulerToggle.checked || !lastPointer) return;
      const line = getLineRectAtPoint(lastPointer.x, lastPointer.y);
      applyMeasurementBasedZoom(lastPointer.x, lastPointer.y, line);
    };

    function updateHighlight(e) {
      if (!rulerToggle.checked) {
        rulerElement.style.display = 'none';
        lastMatchedTop = null;
        clearLineZoom();
        return;
      }

      const boxRect = previewBox.getBoundingClientRect();

      // Check cursor is within previewBox
      if (e.clientX < boxRect.left || e.clientX > boxRect.right || e.clientY < boxRect.top || e.clientY > boxRect.bottom) {
        rulerElement.style.display = 'none';
        lastMatchedTop = null;
        clearLineZoom();
        return;
      }

      const line = getLineRectAtPoint(e.clientX, e.clientY);
      if (!line) {
        rulerElement.style.display = 'none';
        lastMatchedTop = null;
        clearLineZoom();
        return;
      }

      const wrapperRect = previewWrapper.getBoundingClientRect();
      const lineTop = Math.round(line.top - wrapperRect.top - 2);
      const lineHeight = Math.round(line.height + 4);

      // Only update DOM if position changed
      if (lastMatchedTop !== lineTop) {
        lastMatchedTop = lineTop;
        rulerElement.style.display = 'block';
        rulerElement.style.top = `${lineTop}px`;
        rulerElement.style.height = `${lineHeight}px`;
      }

      // Collision-proof zoom: re-measured on EVERY hover (every mousemove).
      // While a mouse button is held (drag-selecting text), leave the text alone.
      lastPointer = { x: e.clientX, y: e.clientY };
      if (e.buttons !== 0) {
        clearLineZoom();
        return;
      }
      applyMeasurementBasedZoom(e.clientX, e.clientY, line);
    }

    // Keep the guide bar aligned to the zoomed line's true visual geometry so the
    // highlight and the gently widened text always line up exactly.
    function refreshRulerGeometry() {
      if (!rulerToggle.checked || !zoomedSpan) return;
      const zoomedRect = zoomedSpan.getBoundingClientRect();
      if (zoomedRect.height <= 0) return;
      const wrapperRect = previewWrapper.getBoundingClientRect();
      rulerElement.style.display = 'block';
      rulerElement.style.top = `${Math.round(zoomedRect.top - wrapperRect.top - 2)}px`;
      rulerElement.style.height = `${Math.round(zoomedRect.height + 4)}px`;
    }

    const rafRefresh = () => { refreshRulerGeometry(); window.requestAnimationFrame(rafRefresh); };
    window.requestAnimationFrame(rafRefresh);

    // Attach mousemove specifically to previewBox
    previewBox.addEventListener('mousemove', updateHighlight);

    previewBox.addEventListener('mouseleave', () => {
      rulerElement.style.display = 'none';
      lastMatchedTop = null;
      lastPointer = null; // Prevent stale-pointer re-zoom on later slider changes
      clearLineZoom();
    });

    rulerToggle.addEventListener('change', (e) => {
      localStorage.setItem('dyslexilens_ruler', e.target.checked);
      if (!e.target.checked) {
        rulerElement.style.display = 'none';
        lastMatchedTop = null;
        clearLineZoom();
      } else {
        applyZoomSettings();
      }
    });
  }

  // 3. Real-Time Live Drag Sliders for Reading Sandbox (Works naturally on text)
  const fontSlider = document.getElementById('font-size-slider');
  const fontVal = document.getElementById('font-size-val');
  
  const letterSlider = document.getElementById('letter-spacing-slider');
  const letterVal = document.getElementById('letter-spacing-val');
  
  const lineSlider = document.getElementById('line-spacing-slider');
  const lineVal = document.getElementById('line-spacing-val');

  if (previewBox) {
    // Font Size Slider
    if (fontSlider && fontVal) {
      fontSlider.addEventListener('input', (e) => {
        const size = e.target.value;
        fontVal.textContent = `${size}px`;
        previewBox.style.fontSize = `${size}px`;
        applyZoomSettings(); // Re-measure: the safe zoom amount just changed
      });
    }

    // Letter Spacing Slider
    if (letterSlider && letterVal) {
      letterSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(3);
        letterVal.textContent = `${parseFloat(val)}em`;
        previewBox.style.letterSpacing = `${val}em`;
        applyZoomSettings(); // Re-measure: the safe zoom amount just changed
      });
    }

    // Line Spacing Slider
    if (lineSlider && lineVal) {
      lineSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value).toFixed(2);
        lineVal.textContent = `${val}x`;
        previewBox.style.lineHeight = `${val}`;
        applyZoomSettings(); // Re-measure: the safe zoom amount just changed
      });
    }
  }

  // 4. Asynchronous Document Upload & OCR Text Extraction
  const uploadForm = document.getElementById('upload-doc-form');
  const fileInput = document.getElementById('document-file-input');
  const extractionStatus = document.getElementById('extraction-status');
  const statusMessage = document.getElementById('status-message');
  const extractBtn = document.getElementById('btn-extract-doc');

  if (uploadForm && fileInput && previewBox) {
    uploadForm.addEventListener('submit', async (e) => {
      if (!fileInput.files || fileInput.files.length === 0) {
        return;
      }

      e.preventDefault();

      const file = fileInput.files[0];
      const formData = new FormData();
      formData.append('document', file);

      if (extractionStatus && statusMessage && extractBtn) {
        extractionStatus.style.display = 'flex';
        statusMessage.textContent = `Processing "${file.name}" with OCR / text extraction...`;
        extractBtn.disabled = true;
        extractBtn.style.opacity = '0.6';
      }

      try {
        const response = await fetch('/upload', {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: formData
        });

        const data = await response.json();

        if (response.ok && data.success) {
          // Keep natural text flow
          originalReadingText = data.text;
          currentSpeechIndex = 0;
          speechSentences = [];
          previewBox.textContent = data.text;
          renderReadingText();
          statusMessage.textContent = `Successfully extracted text from "${data.filename}"!`;
          
          previewBox.scrollIntoView({ behavior: 'smooth', block: 'center' });

          setTimeout(() => {
            if (extractionStatus) extractionStatus.style.display = 'none';
          }, 3500);
        } else {
          statusMessage.textContent = data.error || 'Failed to extract text from document.';
          if (extractionStatus) {
            extractionStatus.style.backgroundColor = 'var(--accent-error-bg)';
            extractionStatus.style.borderColor = 'var(--accent-error-border)';
            extractionStatus.style.color = 'var(--accent-error-text)';
          }
        }
      } catch (err) {
        if (statusMessage) {
          statusMessage.textContent = `Error during extraction: ${err.message}`;
        }
      } finally {
        if (extractBtn) {
          extractBtn.disabled = false;
          extractBtn.style.opacity = '1';
        }
      }
    });
  }

    // ============================================================
  // 5. DYSLEXILENS ACCESSIBILITY READING FEATURES
  //    Bionic Reading + Text-to-Speech + Synchronized Highlighting
  // ============================================================

  let originalReadingText = previewBox ? previewBox.textContent : '';
  let speechSentences = [];
  let currentSpeechIndex = 0;
  let speechIsRunning = false;


  // ------------------------------------------------------------
  // Utility: Escape HTML
  // Prevent OCR text from being interpreted as HTML.
  // ------------------------------------------------------------

  function escapeHTML(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }


  // ------------------------------------------------------------
  // Split extracted text into sentences
  // ------------------------------------------------------------

  function splitIntoSentences(text) {

    if (!text || !text.trim()) {
      return [];
    }

    return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map(sentence => sentence.trim())
      .filter(sentence => sentence.length > 0) || [];
  }


  // ------------------------------------------------------------
  // Bionic-style word formatting
  // ------------------------------------------------------------

  function makeBionicWord(word) {

    if (!word.trim()) {
      return word;
    }

    // Separate punctuation from the word
    const match = word.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9]+)(.*)$/);

    if (!match) {
      return escapeHTML(word);
    }

    const prefix = match[1];
    const actualWord = match[2];
    const suffix = match[3];

    // Emphasize approximately the first 40% of the word
    const boldLength = Math.max(
      1,
      Math.ceil(actualWord.length * 0.4)
    );

    const boldPart = actualWord.substring(0, boldLength);
    const remainingPart = actualWord.substring(boldLength);

    return (
      escapeHTML(prefix) +
      '<strong class="bionic-emphasis">' +
      escapeHTML(boldPart) +
      '</strong>' +
      escapeHTML(remainingPart) +
      escapeHTML(suffix)
    );
  }


  // ------------------------------------------------------------
  // Render the reading area
  // ------------------------------------------------------------

  function renderReadingText() {

    if (!previewBox) return;

    speechSentences = splitIntoSentences(originalReadingText);

    if (speechSentences.length === 0) {
      previewBox.textContent = originalReadingText;
      return;
    }

    const bionicEnabled =
      document.getElementById('toggle-bionic')?.checked || false;

    previewBox.innerHTML = speechSentences
      .map((sentence, index) => {

        let content;

        if (bionicEnabled) {

          content = sentence
            .split(/(\s+)/)
            .map(part => {

              if (/^\s+$/.test(part)) {
                return escapeHTML(part);
              }

              return makeBionicWord(part);

            })
            .join('');

        } else {

          content = escapeHTML(sentence);

        }

        return `
          <span
            class="speech-sentence"
            data-speech-index="${index}">
            ${content}
          </span>
          <span> </span>
        `;

      })
      .join('');
  }


  // ------------------------------------------------------------
  // Bionic toggle
  // ------------------------------------------------------------

  const bionicToggle =
    document.getElementById('toggle-bionic');

  if (bionicToggle) {

    bionicToggle.addEventListener('change', () => {

      // Stop speech before rebuilding the reading DOM
      speechSynthesis.cancel();

      speechIsRunning = false;

      renderReadingText();

      updateSpeechStatus(
        bionicToggle.checked
          ? 'Bionic Reading ON'
          : 'Bionic Reading OFF'
      );

    });
  }


  // ------------------------------------------------------------
  // Font selector
  // ------------------------------------------------------------

  const fontSelector =
    document.getElementById('font-selector');

  if (fontSelector && previewBox) {

    fontSelector.addEventListener('change', (e) => {

      previewBox.style.fontFamily = e.target.value;

      applyZoomSettings();

    });
  }


  // ------------------------------------------------------------
  // Text-to-Speech elements
  // ------------------------------------------------------------

  const speechPlay =
    document.getElementById('speech-play');

  const speechPause =
    document.getElementById('speech-pause');

  const speechStop =
    document.getElementById('speech-stop');

  const speechRate =
    document.getElementById('speech-rate');

  const speechRateValue =
    document.getElementById('speech-rate-value');

  const speechStatus =
    document.getElementById('speech-status');


  // ------------------------------------------------------------
  // Speech status helper
  // ------------------------------------------------------------

  function updateSpeechStatus(message) {

    if (speechStatus) {
      speechStatus.textContent = message;
    }
  }


  // ------------------------------------------------------------
  // Remove current sentence highlight
  // ------------------------------------------------------------

  function clearSpeechHighlight() {

    if (!previewBox) return;

    previewBox
      .querySelectorAll('.speech-sentence')
      .forEach(sentence => {

        sentence.classList.remove('speaking');

      });
  }


  // ------------------------------------------------------------
  // Highlight current sentence
  // ------------------------------------------------------------

  function highlightSpeechSentence(index) {

    clearSpeechHighlight();

    const currentSentence =
      previewBox.querySelector(
        `.speech-sentence[data-speech-index="${index}"]`
      );

    if (!currentSentence) return;

    currentSentence.classList.add('speaking');

    // Automatically bring spoken sentence into view
    currentSentence.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }


  // ------------------------------------------------------------
  // Speak one sentence
  // ------------------------------------------------------------

  function speakSentence(index) {

    if (!speechSentences.length) {

      updateSpeechStatus(
        'Upload or enter some text first.'
      );

      return;
    }


    if (index >= speechSentences.length) {

      speechIsRunning = false;
      currentSpeechIndex = 0;

      clearSpeechHighlight();

      updateSpeechStatus('Finished');

      return;
    }


    currentSpeechIndex = index;

    highlightSpeechSentence(index);

    const utterance =
      new SpeechSynthesisUtterance(
        speechSentences[index]
      );


    // Reading speed
    utterance.rate =
      parseFloat(speechRate?.value || 1);


    utterance.pitch = 1;
    utterance.volume = 1;


    // When sentence finishes
    utterance.onend = () => {

      if (!speechIsRunning) return;

      speakSentence(index + 1);

    };


    utterance.onerror = () => {

      speechIsRunning = false;

      updateSpeechStatus(
        'Speech error'
      );

    };


    updateSpeechStatus(
      `Reading ${index + 1} of ${speechSentences.length}`
    );


    speechSynthesis.speak(utterance);
  }


  // ------------------------------------------------------------
  // PLAY
  // ------------------------------------------------------------

  if (speechPlay) {

    speechPlay.addEventListener('click', () => {

      if (!('speechSynthesis' in window)) {

        updateSpeechStatus(
          'Text-to-Speech is not supported in this browser.'
        );

        return;
      }


      // If paused, resume instead of restarting
      if (speechSynthesis.paused) {

        speechSynthesis.resume();

        speechIsRunning = true;

        updateSpeechStatus(
          `Reading ${currentSpeechIndex + 1} of ${speechSentences.length}`
        );

        return;
      }


      // If currently speaking, don't start another utterance
      if (speechSynthesis.speaking) {
        return;
      }


      // Prepare text if necessary
      if (!speechSentences.length) {

        renderReadingText();

      }


      if (!speechSentences.length) {

        updateSpeechStatus(
          'No text available to read.'
        );

        return;
      }


      speechIsRunning = true;

      speechSynthesis.cancel();

      speakSentence(currentSpeechIndex);

    });
  }


  // ------------------------------------------------------------
  // PAUSE
  // ------------------------------------------------------------

  if (speechPause) {

    speechPause.addEventListener('click', () => {

      if (speechSynthesis.speaking) {

        speechSynthesis.pause();

        updateSpeechStatus('Paused');

      }

    });
  }


  // ------------------------------------------------------------
  // STOP
  // ------------------------------------------------------------

  if (speechStop) {

    speechStop.addEventListener('click', () => {

      speechIsRunning = false;

      speechSynthesis.cancel();

      currentSpeechIndex = 0;

      clearSpeechHighlight();

      updateSpeechStatus('Stopped');

    });
  }


  // ------------------------------------------------------------
  // Speech speed slider
  // ------------------------------------------------------------

  if (speechRate && speechRateValue) {

    speechRate.addEventListener('input', (e) => {

      const value =
        parseFloat(e.target.value).toFixed(1);

      speechRateValue.textContent =
        `${value}×`;

    });

  }


  // ------------------------------------------------------------
  // Keep extracted OCR text as the source for accessibility
  // ------------------------------------------------------------

  const originalUploadHandler =
    uploadForm;

  if (uploadForm) {

    uploadForm.addEventListener('submit', () => {

      // Stop any existing speech
      speechSynthesis.cancel();

      speechIsRunning = false;

    });

  }


  // ------------------------------------------------------------
  // Observe changes to the reading preview.
  // This catches OCR text inserted by the existing upload code.
  // ------------------------------------------------------------

  if (previewBox) {

    const originalPreviewText =
      previewBox.textContent.trim();

    if (originalPreviewText) {
      originalReadingText = originalPreviewText;
    }


    // Keep track of user-entered/editable text.
    previewBox.addEventListener('input', () => {

      // Only update source when not using generated speech markup
      if (
        !previewBox.querySelector('.speech-sentence')
      ) {

        originalReadingText =
          previewBox.textContent;

        speechSentences = [];

      }

    });

  }
});