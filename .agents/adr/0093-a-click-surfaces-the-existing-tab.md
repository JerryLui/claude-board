# 93. A click surfaces the existing tab

2026-08-11 · narrows 57; relates to 72

**Context:** entry 57 accepted that a click on an already-open board may open a duplicate tab, because raising a named tab forward needs the Apple Events automation this bundle had avoided; the reviewer hit the duplicate from both the Banner and the menubar's waiting rows, which open plain board URLs the same way. **Decision:** every board-opening click — the Banner's click child and the menubar waiting row — first looks for the board's URL in the scriptable browsers via osascript (Safari and Chromium dialects) and raises the tab it finds, opening the URL only when none is found. **Consequences:** one Automation permission prompt per browser, a bundle change that re-signs the app so the Documents grant is re-approved once, and an unscriptable browser (Firefox) keeps entry 57's duplicate.
