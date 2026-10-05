/**
 * ReconcilePDF - X-Coordinate Based Column Inference & Table Extraction Engine
 * 
 * Specifically engineered to eliminate the critical column-shifting bug:
 * 1. Capture horizontal position transform[4] (or item.transform[4]) for each PDF text item.
 * 2. Dynamically determine horizontal boundaries (X-coordinate ranges) for each column
 *    (Date, Description, Debit, Credit, Balance) based on table headers.
 * 3. Group text items into rows using their Y-coordinates (with a small tolerance for misalignment).
 * 4. Assign each text item to its corresponding column strictly based on its X-coordinate
 *    intersecting with the column's horizontal X-boundary range.
 * 5. If a column's X-boundary has no text items in a given row, explicitly assign null / ""
 *    so the array length and order are strictly preserved (e.g. [Date, Description, null, Credit, Balance]).
 * 6. Preserves separate Date ("") and Description ("BEGINNING BALANCE") for balance rows without amounts.
 */

(function (global) {
  'use strict';

  /**
   * 1. Captures horizontal and vertical geometry for each PDF.js text block.
   * Horizontal starting position: item.transform[4] or transform[4] (X offset)
   * Vertical starting position: item.transform[5] or transform[5] (Y offset)
   */
  function extractItemGeometry(item) {
    if (!item) return null;
    const text = (item.str || '').trim();
    if (!text) return null;

    const transform = item.transform || [];
    const x = typeof transform[4] === 'number'
      ? transform[4]
      : (typeof item.transform?.[4] === 'number' ? item.transform[4] : (typeof item.x === 'number' ? item.x : 0));
    
    const y = typeof transform[5] === 'number'
      ? transform[5]
      : (typeof item.transform?.[5] === 'number' ? item.transform[5] : (typeof item.y === 'number' ? item.y : 0));

    const width = typeof item.width === 'number' ? item.width : 0;
    const height = typeof item.height === 'number' ? item.height : 0;

    return {
      text: text,
      str: text,
      x: x,
      y: y,
      width: width,
      height: height,
      xStart: x,
      xEnd: x + width,
      xMid: x + (width > 0 ? width / 2 : 0),
      transform: transform,
      rawItem: item
    };
  }

  /**
   * 3. Groups text items into rows using their Y-coordinates (with a small tolerance for misalignment).
   * - yTolerance: defaults to 4.5pt (handles subtle baseline jitter across fonts and renderers)
   * - Sorts rows top-to-bottom (PDF.js Y=0 is at page bottom, so higher Y means higher on page)
   * - Inside each row, sorts text items left-to-right by horizontal starting position (xStart)
   */
  function clusterPageItemsByY(items, pageNum = 1, yTolerance = 4.5) {
    if (!items || !Array.isArray(items)) return [];

    const validGeomItems = [];
    for (const it of items) {
      const geom = extractItemGeometry(it);
      if (geom) validGeomItems.push(geom);
    }

    const rows = [];
    for (const item of validGeomItems) {
      let matchedRow = rows.find(r => Math.abs(r.y - item.y) <= yTolerance);
      if (!matchedRow) {
        matchedRow = { y: item.y, items: [] };
        rows.push(matchedRow);
      } else {
        // Maintain weighted running average Y coordinate for row alignment
        matchedRow.y = (matchedRow.y * matchedRow.items.length + item.y) / (matchedRow.items.length + 1);
      }
      matchedRow.items.push(item);
    }

    // Sort rows top-to-bottom (highest Y to lowest Y in PDF coordinates)
    rows.sort((a, b) => b.y - a.y);

    // Within each row, sort items left-to-right by xStart
    const formattedRows = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.xStart - b.xStart);
      formattedRows.push({
        y: row.y,
        items: row.items,
        texts: row.items.map(it => it.text),
        fullLineStr: row.items.map(it => it.text).join(' ').trim(),
        pageNum: pageNum
      });
    }

    return formattedRows;
  }

  /**
   * Bank Table Column Header Definitions
   * Supports standard international statements, US banks (Chase, BoA, Wells Fargo),
   * and Philippine banks/e-wallets (BPI, BDO, Metrobank, UnionBank, RCBC, GCash, Maya, Landbank).
   */
  /**
   * Bank Table Column Header Definitions
   * Supports standard international statements, US banks (Chase, BoA, Wells Fargo),
   * and Philippine banks/e-wallets (BPI, BDO, Metrobank, UnionBank, RCBC, GCash, Maya, Landbank).
   * 
   * Robust BDO Support: Recognizes multi-word headers containing parentheses:
   * - Column C (Debit): "Withdrawal", "Debit", "Withdrawal (Debit)", "WITHDRAWAL/DEBIT"
   * - Column D (Credit): "Deposit", "Credit", "Deposit (Credit)", "DEPOSIT/CREDIT"
   */
  const HEADER_DEFINITIONS = [
    {
      id: 'date',
      label: 'Date',
      regex: /\b(?:DATE|POST\s*DATE|POSTING\s*DATE|TRANS\s*DATE|TRANSACTION\s*DATE|DATE\s*&\s*TIME|DATE\/TIME|VALUE\s*DATE|PROCESS\s*DATE)\b/i,
      match: (s) => /\b(?:DATE|POST\s*DATE|POSTING\s*DATE|TRANS\s*DATE|TRANSACTION\s*DATE|DATE\s*&\s*TIME|DATE\/TIME|VALUE\s*DATE|PROCESS\s*DATE)\b/i.test(s)
    },
    {
      id: 'description',
      label: 'Description',
      regex: /\b(?:DESCRIPTION|DETAILS|TRANSACTION\s*DETAILS|PARTICULARS|MEMO|PAYEE|TRANSACTION\s*DESCRIPTION|NARRATION|REMARKS|ACTIVITY)\b/i,
      match: (s) => /\b(?:DESCRIPTION|DETAILS|TRANSACTION\s*DETAILS|PARTICULARS|MEMO|PAYEE|TRANSACTION\s*DESCRIPTION|NARRATION|REMARKS|ACTIVITY)\b/i.test(s)
    },
    {
      id: 'debit',
      label: 'Withdrawal (Debit)',
      regex: /(?:WITHDRAWAL\s*[\(\/]?\s*DEBIT[\)]?|\bWITHDRAWALS?\b|\bDEBITS?\b|PAID\s*OUT|CHARGES|OUTFLOW|PAYMENTS?)/i,
      match: (s) => {
        const u = s.toUpperCase();
        return (
          u.includes('WITHDRAWAL (DEBIT)') ||
          u.includes('WITHDRAWAL(DEBIT)') ||
          u.includes('WITHDRAWAL/DEBIT') ||
          u.includes('WITHDRAWAL') ||
          u.includes('DEBIT') ||
          /(?:WITHDRAWAL\s*[\(\/]?\s*DEBIT[\)]?|\bWITHDRAWALS?\b|\bDEBITS?\b|PAID\s*OUT|CHARGES|OUTFLOW|PAYMENTS?)/i.test(u)
        );
      }
    },
    {
      id: 'credit',
      label: 'Deposit (Credit)',
      regex: /(?:DEPOSIT\s*[\(\/]?\s*CREDIT[\)]?|\bDEPOSITS?\b|\bCREDITS?\b|PAID\s*IN|ADDITIONS|INFLOW|RECEIPTS?)/i,
      match: (s) => {
        const u = s.toUpperCase();
        return (
          u.includes('DEPOSIT (CREDIT)') ||
          u.includes('DEPOSIT(CREDIT)') ||
          u.includes('DEPOSIT/CREDIT') ||
          u.includes('DEPOSIT') ||
          u.includes('CREDIT') ||
          /(?:DEPOSIT\s*[\(\/]?\s*CREDIT[\)]?|\bDEPOSITS?\b|\bCREDITS?\b|PAID\s*IN|ADDITIONS|INFLOW|RECEIPTS?)/i.test(u)
        );
      }
    },
    {
      id: 'amount',
      label: 'Amount',
      regex: /(?:AMOUNT\s*[\(\/]?\s*(?:PHP|PESO|USD)?[\)]?|\bAMOUNT\b|\bNET\s*AMOUNT\b|\bTRANS\s*AMOUNT\b|\bTRANSACTION\s*AMOUNT\b|\bINFLOW[\s\/]*OUTFLOW\b)/i,
      match: (s) => {
        const u = s.toUpperCase();
        return (
          u.includes('AMOUNT (PHP)') ||
          u.includes('AMOUNT(PHP)') ||
          u.includes('AMOUNT PHP') ||
          u.includes('NET AMOUNT') ||
          /\bAMOUNT\b/.test(u) ||
          /(?:AMOUNT\s*[\(\/]?\s*(?:PHP|PESO|USD)?[\)]?|\bAMOUNT\b|\bNET\s*AMOUNT\b|\bTRANS\s*AMOUNT\b|\bTRANSACTION\s*AMOUNT\b|\bINFLOW[\s\/]*OUTFLOW\b)/i.test(u)
        );
      }
    },
    {
      id: 'balance',
      label: 'Balance',
      regex: /\b(?:BALANCE|BAL|RUNNING\s*BAL|RUNNING\s*BALANCE|AVAILABLE\s*BAL|AVAILABLE\s*BALANCE|ENDING\s*BAL|ENDING\s*BALANCE|DAILY\s*BALANCE)\b/i,
      match: (s) => /\b(?:BALANCE|BAL|RUNNING\s*BAL|RUNNING\s*BALANCE|AVAILABLE\s*BAL|AVAILABLE\s*BALANCE|ENDING\s*BAL|ENDING\s*BALANCE|DAILY\s*BALANCE)\b/i.test(s)
    }
  ];

  /**
   * 2. Dynamically determine horizontal boundaries (X-coordinate ranges)
   * for each column (Date, Description, Debit, Credit, Balance) based on table headers.
   * 
   * Distinct horizontal boundaries for BDO statements:
   * - Column C (Withdrawal / Debit): around X=315 to 410
   * - Column D (Deposit / Credit): around X=410 to 505
   * Blank cells in either column strictly remain empty without pulling values from neighboring columns.
   * 
   * Single Amount Column statements (e.g., UnionBank):
   * - DO NOT split the Amount column horizontally into Debit and Credit using X-coordinates.
   * - Capture the entire Amount column as a single data entity per row.
   */
  function detectColumnBoundaries(pageRows, options = {}) {
    const pageWidth = options.pageWidth || 612; // Standard letter width at 72dpi

    // 0. Explicit profile boundaries provided
    if (options.boundaries && Array.isArray(options.boundaries) && options.boundaries.length >= 2) {
      const hasDual = options.boundaries.some(b => b.id === 'debit') && options.boundaries.some(b => b.id === 'credit');
      const hasAmt = options.boundaries.some(b => b.id === 'amount');
      return {
        hasHeaders: true,
        headerRowIndex: -1,
        hasDualColumns: hasDual,
        isSingleAmount: hasAmt && !hasDual,
        amountMode: (hasAmt && !hasDual) ? 'single' : (hasDual ? 'dual' : (options.amountMode || 'dual')),
        boundaries: options.boundaries
      };
    }

    // 0b. Preset shortcut for BDO: strictly enforce distinct Column C (315-410) & Column D (410-505)
    if (options.preset === 'bdo' || options.bank === 'bdo') {
      return {
        hasHeaders: true,
        headerRowIndex: -1,
        hasDualColumns: true,
        isSingleAmount: false,
        amountMode: 'dual',
        boundaries: [
          { id: 'date', label: 'Posting Date', minX: 0, maxX: 120, xMid: 60 },
          { id: 'description', label: 'Details', minX: 120, maxX: 315, xMid: 217.5 },
          { id: 'debit', label: 'Withdrawal (Debit)', minX: 315, maxX: 410, xMid: 362.5 },
          { id: 'credit', label: 'Deposit (Credit)', minX: 410, maxX: 505, xMid: 457.5 },
          { id: 'balance', label: 'Balance', minX: 505, maxX: pageWidth + 500, xMid: 550 }
        ]
      };
    }

    // 0c. Preset shortcut for UnionBank: strictly enforce 4-column layout with single Amount column (no horizontal split)
    if (options.preset?.startsWith('unionbank') || options.bank === 'unionbank') {
      return {
        hasHeaders: true,
        headerRowIndex: -1,
        hasDualColumns: false,
        isSingleAmount: true,
        amountMode: 'single',
        boundaries: [
          { id: 'date', label: 'Date', minX: 0, maxX: 120, xMid: 60 },
          { id: 'description', label: 'Description', minX: 120, maxX: 345, xMid: 232.5 },
          { id: 'amount', label: 'Amount (PHP)', minX: 345, maxX: 485, xMid: 415 },
          { id: 'balance', label: 'Running Balance', minX: 485, maxX: pageWidth + 500, xMid: 540 }
        ]
      };
    }

    let bestHeaderMatch = null;
    let maxMatchedCount = 0;

    // Scan up to 60 rows looking for the optimal table header row
    const scanLimit = Math.min(pageRows.length, 60);

    for (let r = 0; r < scanLimit; r++) {
      const row = pageRows[r];
      if (!row || !row.items || row.items.length < 2) continue;

      const foundHeaders = [];
      const matchedIds = new Set();
      const numItems = row.items.length;

      let i = 0;
      while (i < numItems) {
        let matched = false;
        // Check single items and multi-item n-grams (up to 5 items) for phrases like
        // "POSTING DATE", "WITHDRAWAL (DEBIT)", "DEPOSIT (CREDIT)", "RUNNING BALANCE"
        for (let span = 0; span < 5 && (i + span) < numItems; span++) {
          let candidateStr = '';
          let startX = row.items[i].xStart;
          let endX = row.items[i].xEnd;

          for (let k = 0; k <= span; k++) {
            const it = row.items[i + k];
            if (k > 0) {
              if (it.xStart - endX > 28) break;
              candidateStr += ' ';
            }
            candidateStr += it.text;
            endX = it.xEnd;
          }

          const upperCandidate = candidateStr.trim().toUpperCase();

          for (const def of HEADER_DEFINITIONS) {
            if (matchedIds.has(def.id)) continue;

            const isMatch = typeof def.match === 'function'
              ? def.match(upperCandidate)
              : def.regex.test(upperCandidate);

            if (isMatch) {
              matchedIds.add(def.id);
              foundHeaders.push({
                id: def.id,
                label: def.label,
                xStart: startX,
                xEnd: endX,
                xMid: (startX + endX) / 2
              });
              i += span; // Advance past consumed items to prevent overlapping
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        i++;
      }

      // Check if this row is a valid table header
      const hasDateOrDesc = matchedIds.has('date') || matchedIds.has('description');
      const hasMoneyCol = matchedIds.has('debit') || matchedIds.has('credit') || matchedIds.has('amount') || matchedIds.has('balance');

      if (hasDateOrDesc && hasMoneyCol && foundHeaders.length > maxMatchedCount) {
        maxMatchedCount = foundHeaders.length;
        bestHeaderMatch = {
          rowIndex: r,
          headers: foundHeaders
        };
      }
    }

    // If headers detected, build precise column boundary ranges [minX, maxX)
    if (bestHeaderMatch && bestHeaderMatch.headers.length >= 2) {
      const headers = bestHeaderMatch.headers;
      headers.sort((a, b) => a.xStart - b.xStart);

      const hasDualColumns = headers.some(h => h.id === 'debit') && headers.some(h => h.id === 'credit');
      const hasAmountCol = headers.some(h => h.id === 'amount');
      const isSingleAmount = hasAmountCol && !hasDualColumns;

      // Check if headers match BDO statement layout:
      // Debit/Withdrawal around X=300-380, and Credit/Deposit around X=400-480
      const isBdoPattern = headers.some(h => h.id === 'debit' && h.xStart >= 295 && h.xStart <= 385) &&
                           headers.some(h => h.id === 'credit' && h.xStart >= 395 && h.xStart <= 485);

      if (isBdoPattern) {
        return {
          hasHeaders: true,
          headerRowIndex: bestHeaderMatch.rowIndex,
          hasDualColumns: true,
          isSingleAmount: false,
          amountMode: 'dual',
          boundaries: [
            { id: 'date', label: 'Posting Date', minX: 0, maxX: 120, xMid: 60 },
            { id: 'description', label: 'Details', minX: 120, maxX: 315, xMid: 217.5 },
            { id: 'debit', label: 'Withdrawal (Debit)', minX: 315, maxX: 410, xMid: 362.5 },
            { id: 'credit', label: 'Deposit (Credit)', minX: 410, maxX: 505, xMid: 457.5 },
            { id: 'balance', label: 'Balance', minX: 505, maxX: pageWidth + 500, xMid: 550 }
          ]
        };
      }

      const boundaries = [];

      for (let k = 0; k < headers.length; k++) {
        const curr = headers[k];
        let minX = 0;
        let maxX = pageWidth;

        // Left boundary computation
        if (k === 0) {
          minX = 0;
        } else {
          const prev = headers[k - 1];
          if (prev.id === 'description') {
            minX = Math.max(0, curr.xStart - 12);
          } else {
            minX = (prev.xEnd + curr.xStart) / 2;
          }
        }

        // Right boundary computation
        if (k === headers.length - 1) {
          maxX = pageWidth + 500; // Extend past right margin
        } else {
          const next = headers[k + 1];
          if (curr.id === 'description') {
            maxX = Math.max(curr.xEnd, next.xStart - 12);
          } else {
            maxX = (curr.xEnd + next.xStart) / 2;
          }
        }

        // Snap to distinct BDO boundaries if columns are positioned near 315-410 and 410-505
        if (curr.id === 'debit' && Math.abs(minX - 315) < 30) minX = 315;
        if (curr.id === 'debit' && Math.abs(maxX - 410) < 30) maxX = 410;
        if (curr.id === 'credit' && Math.abs(minX - 410) < 30) minX = 410;
        if (curr.id === 'credit' && Math.abs(maxX - 505) < 30) maxX = 505;
        if (curr.id === 'description' && Math.abs(maxX - 315) < 30) maxX = 315;
        if (curr.id === 'balance' && Math.abs(minX - 505) < 30) minX = 505;

        boundaries.push({
          id: curr.id,
          label: curr.label,
          minX: Math.round(minX * 10) / 10,
          maxX: Math.round(maxX * 10) / 10,
          xMid: Math.round(curr.xMid * 10) / 10
        });
      }

      return {
        hasHeaders: true,
        headerRowIndex: bestHeaderMatch.rowIndex,
        hasDualColumns: hasDualColumns,
        isSingleAmount: isSingleAmount,
        amountMode: isSingleAmount ? 'single' : (hasDualColumns ? 'dual' : 'auto'),
        boundaries: boundaries
      };
    }

    // Fallback: Check if single amount mode requested
    if (options.amountMode === 'single') {
      return {
        hasHeaders: false,
        headerRowIndex: -1,
        hasDualColumns: false,
        isSingleAmount: true,
        amountMode: 'single',
        boundaries: [
          { id: 'date', label: 'Date', minX: 0, maxX: 120, xMid: 60 },
          { id: 'description', label: 'Description', minX: 120, maxX: 345, xMid: 232.5 },
          { id: 'amount', label: 'Amount (PHP)', minX: 345, maxX: 485, xMid: 415 },
          { id: 'balance', label: 'Running Balance', minX: 485, maxX: pageWidth + 500, xMid: 540 }
        ]
      };
    }

    // Fallback: Calibrated standard 5-column boundary layout for standard statements
    // [Date: 0-110, Description: 110-350, Debit: 350-435, Credit: 435-520, Balance: 520+]
    return {
      hasHeaders: false,
      headerRowIndex: -1,
      hasDualColumns: true,
      isSingleAmount: false,
      amountMode: 'dual',
      boundaries: [
        { id: 'date', label: 'Date', minX: 0, maxX: 110, xMid: 55 },
        { id: 'description', label: 'Description', minX: 110, maxX: 350, xMid: 230 },
        { id: 'debit', label: 'Debit', minX: 350, maxX: 435, xMid: 392.5 },
        { id: 'credit', label: 'Credit', minX: 435, maxX: 520, xMid: 477.5 },
        { id: 'balance', label: 'Balance', minX: 520, maxX: pageWidth + 500, xMid: 560 }
      ]
    };
  }

  /**
   * 4. Assigns each text item to its corresponding column strictly based on its
   *    X-coordinate intersecting with the column's horizontal boundary range [minX, maxX).
   * 
   * 5. If a column's X-boundary has no text items in a given row, explicitly assigns null
   *    so the array length and order are strictly preserved (e.g. [Date, Description, null, Credit, Balance]).
   */
  function mapRowToColumns(row, columnBoundaries) {
    const boundaries = columnBoundaries.boundaries || columnBoundaries;
    const numCols = boundaries.length;
    const colTexts = new Array(numCols).fill(null);

    if (!row || !row.items || row.items.length === 0) {
      return {
        columns: colTexts,
        hasAnyData: false
      };
    }

    // Partition items into column buckets based on spatial intersection
    for (let c = 0; c < numCols; c++) {
      const b = boundaries[c];
      const itemsInCol = [];

      for (const item of row.items) {
        // An item intersects column boundary if its midpoint falls within [minX, maxX)
        const xMid = typeof item.xMid === 'number' ? item.xMid : (item.x + (item.width || 0) / 2);
        if (xMid >= b.minX && xMid < b.maxX) {
          itemsInCol.push(item);
        }
      }

      if (itemsInCol.length > 0) {
        // Sort items in this column left-to-right
        itemsInCol.sort((a, b) => a.xStart - b.xStart);
        colTexts[c] = itemsInCol.map(it => it.text).join(' ').trim();
      } else {
        // 5. Explicitly assign null for empty PDF cells to preserve strict array length and order!
        colTexts[c] = null;
      }
    }

    return {
      columns: colTexts,
      hasAnyData: colTexts.some(v => v !== null && v !== '')
    };
  }

  /**
   * Currency Cleaners & Philippine Peso Normalizers
   */
  function extractMoneyTokens(str) {
    if (!str) return [];
    // Match monetary tokens: PHP 1,234.56, (PHP 1,250.50), Php 500.00-, ₱1,250.50, (500.00), 1,250.50-, 500.00 DR, 500.00 CR, -45.00, .26, P 1,250.50
    const regex = /(?:\(?\s*(?:PHP|Php|php|₱|\$|€|£|\bP\b|\bP\.\b)\s*\(?|\()?\s*[-−—+–]?\s*(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}\s*\)?\s*[-−—+–]?(?:\s*(?:CR|DR))?\)?/gi;
    const matches = str.match(regex);
    if (!matches) return [];
    return matches.filter(m => /\.\d{2}/.test(m));
  }

  function isNegativeAmountToken(str) {
    if (!str) return false;
    const s = String(str).trim().toUpperCase();
    if (s.startsWith('+') || s.endsWith('+') || /\bCR\b/.test(s)) {
      return false;
    }
    return (
      (s.includes('(') && s.includes(')')) ||
      /^[-−—–]/.test(s) ||
      /[-−—–]$/.test(s) ||
      /\bDR\b/.test(s) ||
      s.includes('-') ||
      s.includes('−')
    );
  }

  function cleanCurrency(str, prevBal = null, currBal = null) {
    if (str === null || str === undefined) return '';
    let val = String(str).trim();
    if (!val) return '';

    // Strip Philippine Peso markers ("PHP", "Php", "₱", "P") and foreign currency markers
    val = val.replace(/(?:PHP|Php|php|₱|[$€£])/gi, '');
    val = val.replace(/\bP\.\b/gi, '');
    val = val.replace(/\bP\b/gi, ''); // Standalone 'P' for Peso
    val = val.replace(/,/g, '');
    val = val.replace(/\s+/g, '');

    // Normalize negative indicators across local styles: (500.00), 500.00-, or DR/CR
    val = val.replace(/^\((.*)\)$/, '$1'); // Parentheses (500.00) -> 500.00
    val = val.replace(/^[-−—+–]/, '');     // Leading minus -500.00 -> 500.00
    val = val.replace(/[-−—+–]$/, '');     // Trailing minus 500.00- -> 500.00
    val = val.replace(/(?:CR|DR)$/i, '').trim(); // Trailing CR/DR
    val = val.replace(/^(?:CR|DR)/i, '').trim(); // Leading CR/DR
    val = val.replace(/[()]/g, '');        // Strip any remaining brackets

    // Handle missing leading zero for decimal numbers: ".26" -> "0.26"
    if (/^\.\d+$/.test(val)) {
      val = '0' + val;
    }

    // Handle standalone cents without leading zero (e.g., "26" when balance delta is 0.26)
    if (/^\d{1,2}$/.test(val)) {
      const intVal = parseInt(val, 10);
      const expectedCents = intVal / 100;
      if (prevBal !== null && currBal !== null) {
        const actualDelta = Math.abs(prevBal - currBal);
        if (Math.abs(actualDelta - expectedCents) < 0.015) {
          return expectedCents.toFixed(2);
        }
      }
    }

    const num = parseFloat(val);
    if (!isNaN(num)) {
      if (val.includes('.')) {
        return num.toFixed(2);
      }
      return val;
    }
    return val;
  }

  const MONTH_MAP = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };

  function extractDate(str, inferredYear) {
    if (!str) return null;
    const trimmed = str.trim();
    const year = inferredYear || new Date().getFullYear().toString();

    // 1. Full standard date: MM/DD/YYYY, MM/DD/YY, DD/MM/YYYY, MM-DD-YYYY
    const mFull = trimmed.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/);
    if (mFull) {
      const p1 = parseInt(mFull[1], 10);
      const p2 = parseInt(mFull[2], 10);
      if (p1 >= 1 && p1 <= 31 && p2 >= 1 && p2 <= 31) {
        let y = mFull[3];
        if (y.length === 2) {
          y = (parseInt(y, 10) > 70 ? '19' : '20') + y;
        }
        return {
          raw: mFull[0],
          formatted: `${String(p1).padStart(2, '0')}/${String(p2).padStart(2, '0')}/${y}`
        };
      }
    }

    // 2. ISO dates: YYYY-MM-DD
    const mIso = trimmed.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})\b/);
    if (mIso) {
      const mNum = parseInt(mIso[2], 10);
      const dNum = parseInt(mIso[3], 10);
      if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
        return {
          raw: mIso[0],
          formatted: `${String(mNum).padStart(2, '0')}/${String(dNum).padStart(2, '0')}/${mIso[1]}`
        };
      }
    }

    // 3. Short-form dates: MM/DD, MM-DD, MM.DD, DD/MM
    const mShort = trimmed.match(/^(\d{1,2})[\/\-\.](\d{1,2})\b/);
    if (mShort) {
      const p1 = parseInt(mShort[1], 10);
      const p2 = parseInt(mShort[2], 10);
      if (p1 >= 1 && p1 <= 31 && p2 >= 1 && p2 <= 31) {
        return {
          raw: mShort[0],
          formatted: `${String(p1).padStart(2, '0')}/${String(p2).padStart(2, '0')}/${year}`
        };
      }
    }

    // 4. Textual month dates: "Oct 02", "Oct 02, 2026", "October 4"
    const mText = trimmed.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
    if (mText) {
      const monthKey = mText[1].slice(0, 3).toLowerCase();
      if (MONTH_MAP[monthKey]) {
        const m = MONTH_MAP[monthKey];
        const dNum = parseInt(mText[2], 10);
        const y = mText[3] || year;
        if (dNum >= 1 && dNum <= 31) {
          return {
            raw: mText[0],
            formatted: `${m}/${String(dNum).padStart(2, '0')}/${y}`
          };
        }
      }
    }

    // 5. Day Month textual: "02 Oct", "04 Oct 2026"
    const mDayText = trimmed.match(/^(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?\b/i);
    if (mDayText) {
      const monthKey = mDayText[2].slice(0, 3).toLowerCase();
      if (MONTH_MAP[monthKey]) {
        const m = MONTH_MAP[monthKey];
        const dNum = parseInt(mDayText[1], 10);
        const y = mDayText[3] || year;
        if (dNum >= 1 && dNum <= 31) {
          return {
            raw: mDayText[0],
            formatted: `${m}/${String(dNum).padStart(2, '0')}/${y}`
          };
        }
      }
    }

    // 6. Day-MonthAbbr-Year: e.g. "05-OCT-26", "12-OCT-2026" (common in BDO & RCBC)
    const mDmyAbbr = trimmed.match(/^(\d{1,2})[\/\-\.]([a-z]{3})[\/\-\.](\d{2,4})\b/i);
    if (mDmyAbbr) {
      const monthKey = mDmyAbbr[2].slice(0, 3).toLowerCase();
      if (MONTH_MAP[monthKey]) {
        const m = MONTH_MAP[monthKey];
        const dNum = parseInt(mDmyAbbr[1], 10);
        let y = mDmyAbbr[3];
        if (y.length === 2) {
          y = (parseInt(y, 10) > 70 ? '19' : '20') + y;
        }
        if (dNum >= 1 && dNum <= 31) {
          return {
            raw: mDmyAbbr[0],
            formatted: `${m}/${String(dNum).padStart(2, '0')}/${y}`
          };
        }
      }
    }

    return null;
  }

  function inferStatementYear(allPageTexts) {
    const currentYear = new Date().getFullYear().toString();
    const joinedText = allPageTexts.join(' \n ');

    const periodMatch = joinedText.match(/(?:Statement\s*Period|Period\s*Covered|Date\s*Range|Through|To|Statement\s*Date|Ending)\s*[:\-]?\s*.*?(\b20[1-3]\d\b)/i);
    if (periodMatch && periodMatch[1]) return periodMatch[1];

    const monthYearMatch = joinedText.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+(\b20[1-3]\d\b)/i);
    if (monthYearMatch && monthYearMatch[1]) return monthYearMatch[1];

    const dateMatch = joinedText.slice(0, 3000).match(/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.](20[1-3]\d)\b/);
    if (dateMatch && dateMatch[1]) return dateMatch[1];

    const headerYears = joinedText.slice(0, 2000).match(/\b20[1-3]\d\b/g);
    if (headerYears && headerYears.length > 0) return headerYears[0];

    return currentYear;
  }

  function detectSectionHeader(lineStr) {
    const s = lineStr.toUpperCase().trim();
    if (s.includes('DAILY BALANCE SUMMARY') || s.includes('DAILY ENDING BALANCE') || s.includes('INTEREST SUMMARY') || s.includes('FEE SUMMARY')) {
      return 'summary';
    }
    if (
      s.includes('TRANSACTIONS BY DATE') ||
      s.includes('TRANSACTION DETAIL') ||
      s.includes('ALL TRANSACTIONS') ||
      s.includes('CHRONOLOGICAL TRANSACTIONS') ||
      s.includes('ACCOUNT ACTIVITY') ||
      s.includes('CHECKING ACTIVITY') ||
      s.includes('TRANSACTION HISTORY')
    ) {
      return 'master';
    }
    if (
      s.includes('DEPOSITS AND ADDITIONS') ||
      s.includes('DEPOSITS AND OTHER CREDITS') ||
      s.includes('DEPOSIT ACTIVITY') ||
      s.includes('CREDITS') ||
      s.includes('ELECTRONIC DEPOSITS') ||
      s.includes('DIRECT DEPOSITS') ||
      (s.startsWith('DEPOSITS') && !s.includes('TOTAL') && !s.includes('AMOUNT'))
    ) {
      return 'credit';
    }
    if (
      s.includes('WITHDRAWALS AND DEDUCTIONS') ||
      s.includes('WITHDRAWALS AND OTHER DEBITS') ||
      s.includes('OTHER WITHDRAWALS') ||
      s.includes('ELECTRONIC WITHDRAWALS') ||
      s.includes('ATM & DEBIT') ||
      s.includes('CHECKS PAID') ||
      s.includes('SERVICE CHARGES') ||
      s.includes('FEES CHARGED') ||
      (s.startsWith('WITHDRAWALS') && !s.includes('TOTAL') && !s.includes('AMOUNT')) ||
      (s.startsWith('CHECKS') && !s.includes('TOTAL') && !s.includes('PAID TO'))
    ) {
      return 'debit';
    }
    return null;
  }

  /**
   * Complete X-Coordinate Based Table Extraction
   * Resolves empty cells, prevents column shifting, and cleanly parses balance rows.
   */
  function extractTransactionsWithCoordinates(allClusteredRows, inferredYear, detectedColInfo) {
    const colBoundaries = detectedColInfo || detectColumnBoundaries(allClusteredRows);
    const rawTransactions = [];
    let currentTx = null;
    let activeSection = null;
    let runningBalance = null;
    let lastValidDate = null;

    const isHeaderRow = (str) => {
      const s = str.toUpperCase();
      return (
        s.includes("POST DATE") ||
        s.includes("TRANSACTION DETAILS") ||
        s.includes("RUNNING BAL") ||
        s.includes("ACCOUNT ACTIVITY") ||
        s.includes("STATEMENT PERIOD") ||
        s.includes("ACCOUNT NUMBER") ||
        s.includes("DAILY BALANCE SUMMARY") ||
        s.includes("CHECKING SUMMARY") ||
        (s.includes("PAGE ") && s.includes(" OF ")) ||
        (s.includes("DATE") && s.includes("DESCRIPTION") && (s.includes("AMOUNT") || s.includes("BALANCE") || s.includes("DEBIT") || s.includes("CREDIT")))
      );
    };

    const isBalanceRow = (str) => {
      const s = str.toUpperCase();
      return (
        s.includes("OPENING BALANCE") ||
        s.includes("BEGINNING BALANCE") ||
        s.includes("STARTING BALANCE") ||
        s.includes("CLOSING BALANCE") ||
        s.includes("ENDING BALANCE")
      );
    };

    // Locate column indices by ID
    const boundaries = colBoundaries.boundaries;
    const dateIdx = boundaries.findIndex(b => b.id === 'date');
    const descIdx = boundaries.findIndex(b => b.id === 'description');
    const debitIdx = boundaries.findIndex(b => b.id === 'debit');
    const creditIdx = boundaries.findIndex(b => b.id === 'credit');
    const amountIdx = boundaries.findIndex(b => b.id === 'amount');
    const balanceIdx = boundaries.findIndex(b => b.id === 'balance');
    const isSingleAmountMode = Boolean(
      colBoundaries.isSingleAmount ||
      colBoundaries.amountMode === 'single' ||
      (amountIdx >= 0 && (debitIdx < 0 || creditIdx < 0))
    );

    for (let r = 0; r < allClusteredRows.length; r++) {
      try {
        const row = allClusteredRows[r];
        if (!row || !row.items || row.items.length === 0) continue;
        const fullLineStr = row.fullLineStr;
        if (!fullLineStr) continue;

        // 1. Check for Category / Master Ledger Section Headers
        const detectedSection = detectSectionHeader(fullLineStr);
        if (detectedSection) {
          activeSection = detectedSection;
          if (currentTx) {
            rawTransactions.push(currentTx);
            currentTx = null;
          }
          continue;
        }

        // 2. Skip table header row
        if (isHeaderRow(fullLineStr)) {
          continue;
        }

        // 3. Map row strictly using X-coordinates
        const mapped = mapRowToColumns(row, colBoundaries);
        const cols = mapped.columns;

        // Check columns
        const rawDateCell = dateIdx >= 0 ? cols[dateIdx] : null;
        const rawDescCell = descIdx >= 0 ? cols[descIdx] : null;
        const rawDebitCell = debitIdx >= 0 ? cols[debitIdx] : null;
        const rawCreditCell = creditIdx >= 0 ? cols[creditIdx] : null;
        const rawAmountCell = amountIdx >= 0 ? cols[amountIdx] : null;
        const rawBalanceCell = balanceIdx >= 0 ? cols[balanceIdx] : null;

        // 4. Handle Opening / Beginning / Closing Balance rows
        // (prevents Date and Description from merging, and preserves separate Balance)
        if (isBalanceRow(fullLineStr) || (rawDescCell && isBalanceRow(rawDescCell))) {
          if (currentTx) {
            rawTransactions.push(currentTx);
            currentTx = null;
          }

          const balText = rawBalanceCell || rawAmountCell || rawCreditCell || '';
          const cleanedBal = cleanCurrency(balText);
          if (cleanedBal) {
            const bNum = parseFloat(cleanedBal);
            if (!isNaN(bNum)) runningBalance = bNum;
          }

          // Description is kept cleanly in Description column, Date is empty string
          const descClean = (rawDescCell || fullLineStr)
            .replace(/[-−—+–]?\$?\(?(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}\)?[-−—+–]?(?:CR|DR)?/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

          rawTransactions.push({
            id: 'tx-bal-' + Math.random().toString(36).substr(2, 7),
            Date: '',
            Description: descClean || 'Beginning Balance',
            Debit: '',
            Credit: '',
            Balance: cleanedBal,
            rawTokens: ['', descClean || 'Beginning Balance', null, null, cleanedBal],
            sourceSection: activeSection === 'master' ? 'master' : (activeSection ? 'category' : 'standard')
          });
          continue;
        }

        // 5. Check if row has a Date (starts a new transaction) or is a grouped transaction inheriting Date
        const dateMatch = extractDate(rawDateCell, inferredYear) || (dateIdx < 0 ? extractDate(row.items[0]?.text, inferredYear) : null);

        const cleanedDebit = rawDebitCell ? cleanCurrency(rawDebitCell) : '';
        const cleanedCredit = rawCreditCell ? cleanCurrency(rawCreditCell) : '';
        const cleanedAmount = rawAmountCell ? cleanCurrency(rawAmountCell) : '';
        const cleanedBalance = rawBalanceCell ? cleanCurrency(rawBalanceCell) : '';

        const hasDebit = Boolean(cleanedDebit);
        const hasCredit = Boolean(cleanedCredit);
        const hasAmount = Boolean(cleanedAmount);
        const hasBalance = Boolean(cleanedBalance);
        const hasNumericalValue = hasDebit || hasCredit || hasAmount || hasBalance;
        const hasDescription = Boolean(rawDescCell && String(rawDescCell).trim().length > 0);

        // Relax Row Discard Rules: A row is considered valid and kept if it has a Description
        // AND at least one numerical value (Debit, Credit, Amount, or Balance)
        const hasValidTransactionData = hasDescription && hasNumericalValue;

        if (dateMatch || hasValidTransactionData) {
          // Finalize previous transaction
          if (currentTx) {
            rawTransactions.push(currentTx);
          }

          let effectiveDate = '';
          if (dateMatch) {
            lastValidDate = dateMatch.formatted;
            effectiveDate = dateMatch.formatted;
          } else if (hasValidTransactionData) {
            // Grouped Dates: automatically assign lastValidDate to this row's Date column
            effectiveDate = lastValidDate || '';
          }

          let debitVal = '';
          let creditVal = '';
          let balanceVal = '';

          if (isSingleAmountMode || (amountIdx >= 0 && (debitIdx < 0 || creditIdx < 0))) {
            // SINGLE AMOUNT COLUMN (+/-):
            // Implement Sign-Based Routing (Mathematical Outflow vs Inflow):
            // Inspect the numerical value and signs of the extracted amount:
            // * If the amount contains a negative sign ("-") or parentheses "(x.xx)":
            //   - Strip the negative symbol / parentheses.
            //   - Place the absolute value into Col C (Debit / Outflow).
            //   - Set Col D (Credit) to null / empty.
            // * If the amount is positive (no minus sign, standard number):
            //   - Place the value into Col D (Credit / Inflow).
            //   - Set Col C (Debit) to null / empty.
            const rawAmt = rawAmountCell || rawDebitCell || rawCreditCell || '';
            if (rawAmt) {
              const isNegative = isNegativeAmountToken(rawAmt);
              const cleaned = cleanCurrency(rawAmt);
              if (isNegative) {
                debitVal = cleaned;
                creditVal = '';
              } else {
                creditVal = cleaned;
                debitVal = '';
              }
            }
          } else if (debitIdx >= 0 && creditIdx >= 0) {
            // Dual Column mapping (strictly preserves empty Debit vs empty Credit without shifting)
            debitVal = rawDebitCell ? cleanCurrency(rawDebitCell) : '';
            creditVal = rawCreditCell ? cleanCurrency(rawCreditCell) : '';
          } else if (amountIdx >= 0 || debitIdx >= 0) {
            // Fallback single amount column with sign-based routing
            const rawAmt = rawAmountCell || rawDebitCell || '';
            if (rawAmt) {
              const isNegative = isNegativeAmountToken(rawAmt);
              const cleaned = cleanCurrency(rawAmt);
              if (isNegative) {
                debitVal = cleaned;
                creditVal = '';
              } else {
                creditVal = cleaned;
                debitVal = '';
              }
            }
          }

          if (rawBalanceCell) {
            balanceVal = cleanCurrency(rawBalanceCell);
            const bNum = parseFloat(balanceVal);
            if (!isNaN(bNum)) runningBalance = bNum;
          }

          // Build raw token array strictly preserving coordinate-mapped columns
          // Empty cells are explicitly null to preserve length and order: [Date, Description, null, Credit, Balance]
          const stableTokens = [
            effectiveDate,
            rawDescCell || 'Transaction',
            debitVal ? debitVal : null,
            creditVal ? creditVal : null,
            balanceVal ? balanceVal : null
          ];

          currentTx = {
            id: 'tx-' + Math.random().toString(36).substr(2, 9),
            Date: effectiveDate,
            Description: rawDescCell || 'Transaction',
            Debit: debitVal,
            Credit: creditVal,
            Balance: balanceVal,
            rawTokens: stableTokens,
            sourceSection: activeSection === 'master' ? 'master' : (activeSection ? 'category' : 'standard')
          };

        } else if (currentTx) {
          // 6. Stacked subsequent row: append Description continuation lines
          if (rawDescCell && !rawDebitCell && !rawCreditCell && !rawAmountCell) {
            const extraDesc = rawDescCell
              .replace(/[-−—+–]?\$?\(?(?:\d{1,3}(?:,\d{3})+|\d+)?\.\d{2}\)?[-−—+–]?(?:CR|DR)?/gi, '')
              .trim();
            if (extraDesc) {
              currentTx.Description += ' ' + extraDesc;
              if (currentTx.rawTokens && currentTx.rawTokens.length > 1) {
                currentTx.rawTokens[1] = currentTx.Description;
              }
            }
          }
        }

      } catch (err) {
        console.warn('[ReconcilePDF Coordinate Parser Warning]:', err);
      }
    }

    if (currentTx) {
      rawTransactions.push(currentTx);
    }

    return deduplicateTransactions(rawTransactions);
  }

  function deduplicateTransactions(transactions) {
    const result = [];
    const masterSignatures = new Set();
    const seenSignatures = new Set();

    for (const tx of transactions) {
      if (tx.sourceSection === 'master') {
        masterSignatures.add(getTxSignature(tx));
      }
    }

    const hasMaster = masterSignatures.size > 0;

    for (const tx of transactions) {
      const sig = getTxSignature(tx);

      if (hasMaster && tx.sourceSection === 'category') {
        if (masterSignatures.has(sig)) continue;
      }

      if (seenSignatures.has(sig)) {
        if (tx.sourceSection === 'category' || (tx.Balance && result.some(r => r.Balance === tx.Balance && getTxSignature(r) === sig))) {
          continue;
        }
      }

      seenSignatures.add(sig);
      result.push(tx);
    }

    return result;
  }

  function getTxSignature(tx) {
    const normDate = (tx.Date || '').trim();
    const dVal = tx.Debit ? parseFloat(tx.Debit.replace(/,/g, '')).toFixed(2) : '';
    const cVal = tx.Credit ? parseFloat(tx.Credit.replace(/,/g, '')).toFixed(2) : '';
    const normDesc = (tx.Description || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 24);
    return `${normDate}|${dVal}|${cVal}|${normDesc}`;
  }

  /**
   * BDO (Banco de Oro) Benchmark Dataset
   * Fully calibrated with authentic coordinates:
   * Column C (Withdrawal / Debit): around X=315 to 410
   * Column D (Deposit / Credit): around X=410 to 505
   * Total Debits: -₱10,341.35
   * Total Credits: +₱8,004.25
   * Net Flux: -₱2,337.10
   */
  function getBdoSampleClusteredRows() {
    function makeRow(y, items) {
      const formattedItems = items.map(it => ({
        text: it.text,
        str: it.text,
        x: it.xStart,
        y: y,
        width: it.width,
        height: 10,
        xStart: it.xStart,
        xEnd: it.xStart + it.width,
        xMid: it.xStart + it.width / 2
      }));
      return {
        y: y,
        items: formattedItems,
        texts: formattedItems.map(it => it.text),
        fullLineStr: formattedItems.map(it => it.text).join(' '),
        pageNum: 1
      };
    }

    return [
      makeRow(700, [
        { text: 'POSTING DATE', xStart: 40, width: 65 },
        { text: 'DETAILS', xStart: 130, width: 50 },
        { text: 'WITHDRAWAL (DEBIT)', xStart: 325, width: 75 },
        { text: 'DEPOSIT (CREDIT)', xStart: 420, width: 70 },
        { text: 'BALANCE', xStart: 520, width: 50 }
      ]),
      makeRow(670, [
        { text: 'BEGINNING BALANCE', xStart: 130, width: 110 },
        { text: '25,000.00', xStart: 520, width: 50 }
      ]),
      makeRow(645, [
        { text: '10/01/2026', xStart: 40, width: 55 },
        { text: 'SALARY DIRECT DEPOSIT - ACME BPO PH', xStart: 130, width: 170 },
        { text: '5,000.00', xStart: 440, width: 45 },
        { text: '30,000.00', xStart: 520, width: 50 }
      ]),
      makeRow(620, [
        { text: '10/02/2026', xStart: 40, width: 55 },
        { text: 'BDO ATM CASH WITHDRAWAL MAKATI AVE', xStart: 130, width: 170 },
        { text: '5,000.00', xStart: 345, width: 45 },
        { text: '25,000.00', xStart: 520, width: 50 }
      ]),
      makeRow(595, [
        { text: '10/05/2026', xStart: 40, width: 55 },
        { text: 'SM STORE MEGAMALL MANDALUYONG', xStart: 130, width: 160 },
        { text: '2,450.50', xStart: 345, width: 45 },
        { text: '22,549.50', xStart: 520, width: 50 }
      ]),
      makeRow(570, [
        { text: '10/12/2026', xStart: 40, width: 55 },
        { text: 'MERALCO ONLINE PAYMENT ELEC BILL', xStart: 130, width: 165 },
        { text: '1,841.35', xStart: 345, width: 45 },
        { text: '20,708.15', xStart: 520, width: 50 }
      ]),
      makeRow(545, [
        { text: '10/15/2026', xStart: 40, width: 55 },
        { text: 'INWARD FUND TRANSFER INSTAPAY', xStart: 130, width: 155 },
        { text: '3,000.00', xStart: 440, width: 45 },
        { text: '23,708.15', xStart: 520, width: 50 }
      ]),
      makeRow(520, [
        { text: '10/18/2026', xStart: 40, width: 55 },
        { text: 'GRABFOOD PHILIPPINES ORDER', xStart: 130, width: 145 },
        { text: '650.00', xStart: 350, width: 35 },
        { text: '23,058.15', xStart: 520, width: 50 }
      ]),
      makeRow(495, [
        { text: '10/24/2026', xStart: 40, width: 55 },
        { text: 'SHOPEE PAY TOPUP PH0917234', xStart: 130, width: 150 },
        { text: '399.50', xStart: 350, width: 35 },
        { text: '22,658.65', xStart: 520, width: 50 }
      ]),
      makeRow(470, [
        { text: '10/31/2026', xStart: 40, width: 55 },
        { text: 'INTEREST CREDIT TAX WITHHELD', xStart: 130, width: 150 },
        { text: '4.25', xStart: 450, width: 25 },
        { text: '22,662.90', xStart: 520, width: 50 }
      ])
    ];
  }

  function getBdoSampleTransactions() {
    return [
      { id: 'tx-bdo-0', Date: '', Description: 'BEGINNING BALANCE', Debit: '', Credit: '', Balance: '25,000.00', rawTokens: ['', 'BEGINNING BALANCE', null, null, '25,000.00'] },
      { id: 'tx-bdo-1', Date: '10/01/2026', Description: 'SALARY DIRECT DEPOSIT - ACME BPO PH', Debit: '', Credit: '5,000.00', Balance: '30,000.00', rawTokens: ['10/01/2026', 'SALARY DIRECT DEPOSIT - ACME BPO PH', null, '5,000.00', '30,000.00'] },
      { id: 'tx-bdo-2', Date: '10/02/2026', Description: 'BDO ATM CASH WITHDRAWAL MAKATI AVE', Debit: '5,000.00', Credit: '', Balance: '25,000.00', rawTokens: ['10/02/2026', 'BDO ATM CASH WITHDRAWAL MAKATI AVE', '5,000.00', null, '25,000.00'] },
      { id: 'tx-bdo-3', Date: '10/05/2026', Description: 'SM STORE MEGAMALL MANDALUYONG', Debit: '2,450.50', Credit: '', Balance: '22,549.50', rawTokens: ['10/05/2026', 'SM STORE MEGAMALL MANDALUYONG', '2,450.50', null, '22,549.50'] },
      { id: 'tx-bdo-4', Date: '10/12/2026', Description: 'MERALCO ONLINE PAYMENT ELEC BILL', Debit: '1,841.35', Credit: '', Balance: '20,708.15', rawTokens: ['10/12/2026', 'MERALCO ONLINE PAYMENT ELEC BILL', '1,841.35', null, '20,708.15'] },
      { id: 'tx-bdo-5', Date: '10/15/2026', Description: 'INWARD FUND TRANSFER INSTAPAY', Debit: '', Credit: '3,000.00', Balance: '23,708.15', rawTokens: ['10/15/2026', 'INWARD FUND TRANSFER INSTAPAY', null, '3,000.00', '23,708.15'] },
      { id: 'tx-bdo-6', Date: '10/18/2026', Description: 'GRABFOOD PHILIPPINES ORDER', Debit: '650.00', Credit: '', Balance: '23,058.15', rawTokens: ['10/18/2026', 'GRABFOOD PHILIPPINES ORDER', '650.00', null, '23,058.15'] },
      { id: 'tx-bdo-7', Date: '10/24/2026', Description: 'SHOPEE PAY TOPUP PH0917234', Debit: '399.50', Credit: '', Balance: '22,658.65', rawTokens: ['10/24/2026', 'SHOPEE PAY TOPUP PH0917234', '399.50', null, '22,658.65'] },
      { id: 'tx-bdo-8', Date: '10/31/2026', Description: 'INTEREST CREDIT TAX WITHHELD', Debit: '', Credit: '4.25', Balance: '22,662.90', rawTokens: ['10/31/2026', 'INTEREST CREDIT TAX WITHHELD', null, '4.25', '22,662.90'] }
    ];
  }

  /**
   * UnionBank Benchmark Dataset - Test 1
   * Single Amount Column (+/-) with Sign-Based Routing
   * Table Header: [DATE, DESCRIPTION, AMOUNT (PHP), RUNNING BALANCE]
   * Debits: -₱5,470.25 (1,500.00 + 3,450.25 + 520.00)
   * Credits: +₱22,011.15 (22,000.00 + 11.15)
   * Net Flux: +₱16,540.90
   */
  function getUnionBankSample1ClusteredRows() {
    function makeRow(y, items) {
      const formattedItems = items.map(it => ({
        text: it.text,
        str: it.text,
        x: it.xStart,
        y: y,
        width: it.width,
        height: 10,
        xStart: it.xStart,
        xEnd: it.xStart + it.width,
        xMid: it.xStart + it.width / 2
      }));
      return {
        y: y,
        items: formattedItems,
        texts: formattedItems.map(it => it.text),
        fullLineStr: formattedItems.map(it => it.text).join(' '),
        pageNum: 1
      };
    }

    return [
      makeRow(700, [
        { text: 'DATE', xStart: 40, width: 50 },
        { text: 'DESCRIPTION', xStart: 130, width: 100 },
        { text: 'AMOUNT (PHP)', xStart: 360, width: 85 },
        { text: 'RUNNING BALANCE', xStart: 490, width: 90 }
      ]),
      makeRow(670, [
        { text: 'BEGINNING BALANCE', xStart: 130, width: 120 },
        { text: '10,000.00', xStart: 490, width: 60 }
      ]),
      makeRow(640, [
        { text: '10/01/2026', xStart: 40, width: 55 },
        { text: 'PAYROLL CREDIT ACME CORP', xStart: 130, width: 160 },
        { text: '22,000.00', xStart: 360, width: 60 },
        { text: '32,000.00', xStart: 490, width: 60 }
      ]),
      makeRow(610, [
        { text: '10/05/2026', xStart: 40, width: 55 },
        { text: 'UNIONBANK ATM CASH WITHDRAWAL MAKATI', xStart: 130, width: 180 },
        { text: '-1,500.00', xStart: 360, width: 60 },
        { text: '30,500.00', xStart: 490, width: 60 }
      ]),
      makeRow(580, [
        { text: '10/12/2026', xStart: 40, width: 55 },
        { text: 'MERALCO ONLINE BILL PAYMENT ELEC', xStart: 130, width: 170 },
        { text: '-3,450.25', xStart: 360, width: 60 },
        { text: '27,049.75', xStart: 490, width: 60 }
      ]),
      makeRow(550, [
        { text: '10/20/2026', xStart: 40, width: 55 },
        { text: 'GRABFOOD MANILA ONLINE ORDER', xStart: 130, width: 150 },
        { text: '-520.00', xStart: 360, width: 50 },
        { text: '26,529.75', xStart: 490, width: 60 }
      ]),
      makeRow(520, [
        { text: '10/31/2026', xStart: 40, width: 55 },
        { text: 'INTEREST CREDIT TAX WITHHELD', xStart: 130, width: 150 },
        { text: '11.15', xStart: 360, width: 40 },
        { text: '26,540.90', xStart: 490, width: 60 }
      ])
    ];
  }

  function getUnionBankSample1Transactions() {
    return [
      { id: 'tx-ub1-0', Date: '', Description: 'BEGINNING BALANCE', Debit: '', Credit: '', Balance: '10,000.00', rawTokens: ['', 'BEGINNING BALANCE', null, null, '10,000.00'] },
      { id: 'tx-ub1-1', Date: '10/01/2026', Description: 'PAYROLL CREDIT ACME CORP', Debit: '', Credit: '22,000.00', Balance: '32,000.00', rawTokens: ['10/01/2026', 'PAYROLL CREDIT ACME CORP', null, '22,000.00', '32,000.00'] },
      { id: 'tx-ub1-2', Date: '10/05/2026', Description: 'UNIONBANK ATM CASH WITHDRAWAL MAKATI', Debit: '1,500.00', Credit: '', Balance: '30,500.00', rawTokens: ['10/05/2026', 'UNIONBANK ATM CASH WITHDRAWAL MAKATI', '1,500.00', null, '30,500.00'] },
      { id: 'tx-ub1-3', Date: '10/12/2026', Description: 'MERALCO ONLINE BILL PAYMENT ELEC', Debit: '3,450.25', Credit: '', Balance: '27,049.75', rawTokens: ['10/12/2026', 'MERALCO ONLINE BILL PAYMENT ELEC', '3,450.25', null, '27,049.75'] },
      { id: 'tx-ub1-4', Date: '10/20/2026', Description: 'GRABFOOD MANILA ONLINE ORDER', Debit: '520.00', Credit: '', Balance: '26,529.75', rawTokens: ['10/20/2026', 'GRABFOOD MANILA ONLINE ORDER', '520.00', null, '26,529.75'] },
      { id: 'tx-ub1-5', Date: '10/31/2026', Description: 'INTEREST CREDIT TAX WITHHELD', Debit: '', Credit: '11.15', Balance: '26,540.90', rawTokens: ['10/31/2026', 'INTEREST CREDIT TAX WITHHELD', null, '11.15', '26,540.90'] }
    ];
  }

  /**
   * UnionBank Benchmark Dataset - Test 2
   * Single Amount Column (+/-) with Sign-Based Routing
   * Table Header: [DATE, DESCRIPTION, AMOUNT (PHP), RUNNING BALANCE]
   * Debits: -₱16,260.50 (9,800.00 + 2,150.00 + 4,310.50)
   * Credits: +₱18,507.45 (18,500.00 + 7.45)
   * Net Flux: +₱2,246.95
   */
  function getUnionBankSample2ClusteredRows() {
    function makeRow(y, items) {
      const formattedItems = items.map(it => ({
        text: it.text,
        str: it.text,
        x: it.xStart,
        y: y,
        width: it.width,
        height: 10,
        xStart: it.xStart,
        xEnd: it.xStart + it.width,
        xMid: it.xStart + it.width / 2
      }));
      return {
        y: y,
        items: formattedItems,
        texts: formattedItems.map(it => it.text),
        fullLineStr: formattedItems.map(it => it.text).join(' '),
        pageNum: 1
      };
    }

    return [
      makeRow(700, [
        { text: 'DATE', xStart: 40, width: 50 },
        { text: 'DESCRIPTION', xStart: 130, width: 100 },
        { text: 'AMOUNT (PHP)', xStart: 360, width: 85 },
        { text: 'RUNNING BALANCE', xStart: 490, width: 90 }
      ]),
      makeRow(670, [
        { text: 'BEGINNING BALANCE', xStart: 130, width: 120 },
        { text: '5,000.00', xStart: 490, width: 60 }
      ]),
      makeRow(640, [
        { text: '10/02/2026', xStart: 40, width: 55 },
        { text: 'INWARD REMITTANCE FREELANCE INVOICE', xStart: 130, width: 180 },
        { text: '18,500.00', xStart: 360, width: 60 },
        { text: '23,500.00', xStart: 490, width: 60 }
      ]),
      makeRow(610, [
        { text: '10/06/2026', xStart: 40, width: 55 },
        { text: 'CONDO RENT BGC OCT 2026', xStart: 130, width: 150 },
        { text: '-9,800.00', xStart: 360, width: 60 },
        { text: '13,700.00', xStart: 490, width: 60 }
      ]),
      makeRow(580, [
        { text: '10/14/2026', xStart: 40, width: 55 },
        { text: 'CREDIT CARD PAYMENT UB VISA', xStart: 130, width: 160 },
        { text: '(2,150.00)', xStart: 360, width: 60 },
        { text: '11,550.00', xStart: 490, width: 60 }
      ]),
      makeRow(550, [
        { text: '10/22/2026', xStart: 40, width: 55 },
        { text: 'SM STORE APPLIANCE MEGACENTER', xStart: 130, width: 170 },
        { text: '-4,310.50', xStart: 360, width: 60 },
        { text: '7,239.50', xStart: 490, width: 60 }
      ]),
      makeRow(520, [
        { text: '10/31/2026', xStart: 40, width: 55 },
        { text: 'MONTHLY SAVINGS INTEREST EARNED', xStart: 130, width: 170 },
        { text: '7.45', xStart: 360, width: 40 },
        { text: '7,246.95', xStart: 490, width: 60 }
      ])
    ];
  }

  function getUnionBankSample2Transactions() {
    return [
      { id: 'tx-ub2-0', Date: '', Description: 'BEGINNING BALANCE', Debit: '', Credit: '', Balance: '5,000.00', rawTokens: ['', 'BEGINNING BALANCE', null, null, '5,000.00'] },
      { id: 'tx-ub2-1', Date: '10/02/2026', Description: 'INWARD REMITTANCE FREELANCE INVOICE', Debit: '', Credit: '18,500.00', Balance: '23,500.00', rawTokens: ['10/02/2026', 'INWARD REMITTANCE FREELANCE INVOICE', null, '18,500.00', '23,500.00'] },
      { id: 'tx-ub2-2', Date: '10/06/2026', Description: 'CONDO RENT BGC OCT 2026', Debit: '9,800.00', Credit: '', Balance: '13,700.00', rawTokens: ['10/06/2026', 'CONDO RENT BGC OCT 2026', '9,800.00', null, '13,700.00'] },
      { id: 'tx-ub2-3', Date: '10/14/2026', Description: 'CREDIT CARD PAYMENT UB VISA', Debit: '2,150.00', Credit: '', Balance: '11,550.00', rawTokens: ['10/14/2026', 'CREDIT CARD PAYMENT UB VISA', '2,150.00', null, '11,550.00'] },
      { id: 'tx-ub2-4', Date: '10/22/2026', Description: 'SM STORE APPLIANCE MEGACENTER', Debit: '4,310.50', Credit: '', Balance: '7,239.50', rawTokens: ['10/22/2026', 'SM STORE APPLIANCE MEGACENTER', '4,310.50', null, '7,239.50'] },
      { id: 'tx-ub2-5', Date: '10/31/2026', Description: 'MONTHLY SAVINGS INTEREST EARNED', Debit: '', Credit: '7.45', Balance: '7,246.95', rawTokens: ['10/31/2026', 'MONTHLY SAVINGS INTEREST EARNED', null, '7.45', '7,246.95'] }
    ];
  }

  /**
   * PNB (Philippine National Bank) Benchmark Dataset
   * Multi-transaction same-day grouped dates (Col A is blank for subsequent transactions)
   * Debits: -₱6,525.00 (2,000.00 + 3,500.00 + 25.00 + 1,000.00)
   * Credits: +₱15,000.00
   * Net Cash Flow: +₱8,475.00
   * Ending Balance: ₱18,475.00
   */
  function getPNBSampleClusteredRows() {
    function makeRow(y, items) {
      const formattedItems = items.map(it => ({
        text: it.text,
        str: it.text,
        x: it.xStart,
        y: y,
        width: it.width,
        height: 10,
        xStart: it.xStart,
        xEnd: it.xStart + it.width,
        xMid: it.xStart + it.width / 2
      }));
      return {
        y: y,
        items: formattedItems,
        texts: formattedItems.map(it => it.text),
        fullLineStr: formattedItems.map(it => it.text).join(' '),
        pageNum: 1
      };
    }

    return [
      makeRow(700, [
        { text: 'DATE', xStart: 40, width: 45 },
        { text: 'TRANSACTION DESCRIPTION', xStart: 130, width: 150 },
        { text: 'DEBIT', xStart: 350, width: 50 },
        { text: 'CREDIT', xStart: 440, width: 50 },
        { text: 'BALANCE', xStart: 530, width: 50 }
      ]),
      makeRow(670, [
        { text: 'BEGINNING BALANCE', xStart: 130, width: 120 },
        { text: '10,000.00', xStart: 530, width: 60 }
      ]),
      makeRow(640, [
        { text: '10/01/2026', xStart: 40, width: 60 },
        { text: 'PAYROLL DIRECT DEPOSIT - TECH CORP', xStart: 130, width: 190 },
        { text: '15,000.00', xStart: 440, width: 55 },
        { text: '25,000.00', xStart: 530, width: 60 }
      ]),
      makeRow(610, [
        { text: '10/05/2026', xStart: 40, width: 60 },
        { text: 'PNB ATM CASH WITHDRAWAL AYALA', xStart: 130, width: 180 },
        { text: '2,000.00', xStart: 350, width: 50 },
        { text: '23,000.00', xStart: 530, width: 60 }
      ]),
      // GROUPED DATE: Blank Date cell, has Description and Debit and Balance
      makeRow(580, [
        { text: 'MERALCO ELECTRIC BILL PAYMENT', xStart: 130, width: 180 },
        { text: '3,500.00', xStart: 350, width: 50 },
        { text: '19,500.00', xStart: 530, width: 60 }
      ]),
      // Multi-line description continuation
      makeRow(565, [
        { text: 'ACCOUNT NO 09482948294 REF 882194', xStart: 130, width: 180 }
      ]),
      // GROUPED DATE: Blank Date cell, has Description and Debit and Balance
      makeRow(540, [
        { text: 'INSTAPAY INTERBANK TRANSFER FEE', xStart: 130, width: 180 },
        { text: '25.00', xStart: 350, width: 40 },
        { text: '19,475.00', xStart: 530, width: 60 }
      ]),
      makeRow(510, [
        { text: '10/12/2026', xStart: 40, width: 60 },
        { text: 'SM SUPERMARKET GROCERY PURCHASE', xStart: 130, width: 180 },
        { text: '1,000.00', xStart: 350, width: 50 },
        { text: '18,475.00', xStart: 530, width: 60 }
      ])
    ];
  }

  function getPNBSampleTransactions() {
    return [
      { id: 'tx-pnb-0', Date: '', Description: 'BEGINNING BALANCE', Debit: '', Credit: '', Balance: '10,000.00', rawTokens: ['', 'BEGINNING BALANCE', null, null, '10,000.00'] },
      { id: 'tx-pnb-1', Date: '10/01/2026', Description: 'PAYROLL DIRECT DEPOSIT - TECH CORP', Debit: '', Credit: '15,000.00', Balance: '25,000.00', rawTokens: ['10/01/2026', 'PAYROLL DIRECT DEPOSIT - TECH CORP', null, '15,000.00', '25,000.00'] },
      { id: 'tx-pnb-2', Date: '10/05/2026', Description: 'PNB ATM CASH WITHDRAWAL AYALA', Debit: '2,000.00', Credit: '', Balance: '23,000.00', rawTokens: ['10/05/2026', 'PNB ATM CASH WITHDRAWAL AYALA', '2,000.00', null, '23,000.00'] },
      { id: 'tx-pnb-3', Date: '10/05/2026', Description: 'MERALCO ELECTRIC BILL PAYMENT ACCOUNT NO 09482948294 REF 882194', Debit: '3,500.00', Credit: '', Balance: '19,500.00', rawTokens: ['10/05/2026', 'MERALCO ELECTRIC BILL PAYMENT ACCOUNT NO 09482948294 REF 882194', '3,500.00', null, '19,500.00'] },
      { id: 'tx-pnb-4', Date: '10/05/2026', Description: 'INSTAPAY INTERBANK TRANSFER FEE', Debit: '25.00', Credit: '', Balance: '19,475.00', rawTokens: ['10/05/2026', 'INSTAPAY INTERBANK TRANSFER FEE', '25.00', null, '19,475.00'] },
      { id: 'tx-pnb-5', Date: '10/12/2026', Description: 'SM SUPERMARKET GROCERY PURCHASE', Debit: '1,000.00', Credit: '', Balance: '18,475.00', rawTokens: ['10/12/2026', 'SM SUPERMARKET GROCERY PURCHASE', '1,000.00', null, '18,475.00'] }
    ];
  }

  // Export to global scope / module
  const ReconcileParser = {
    extractItemGeometry,
    clusterPageItemsByY,
    detectColumnBoundaries,
    mapRowToColumns,
    extractTransactionsWithCoordinates,
    cleanCurrency,
    isNegativeAmountToken,
    extractMoneyTokens,
    extractDate,
    inferStatementYear,
    detectSectionHeader,
    deduplicateTransactions,
    getTxSignature,
    getBdoSampleClusteredRows,
    getBdoSampleTransactions,
    getUnionBankSample1ClusteredRows,
    getUnionBankSample1Transactions,
    getUnionBankSample2ClusteredRows,
    getUnionBankSample2Transactions,
    getPNBSampleClusteredRows,
    getPNBSampleTransactions
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReconcileParser;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.ReconcileParser = ReconcileParser;
  }
  if (typeof window !== 'undefined') {
    window.ReconcileParser = ReconcileParser;
  }

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
