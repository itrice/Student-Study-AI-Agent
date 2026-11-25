import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function readPublic(name) {
  return fs.readFileSync(
    new URL(`../public/${name}`, import.meta.url),
    "utf8"
  );
}

test("所有录入入口先提供拍照录入和手工录入选择", () => {
  const html = readPublic("index.html");
  const app = readPublic("app.js");
  const styles = readPublic("styles.css");

  assert.match(html, /<dialog[\s\S]*id="entry-choice-dialog"/);
  assert.match(html, /id="entry-photo-button"[\s\S]*>拍照录入/);
  assert.match(html, /id="entry-manual-button"[\s\S]*>手工录入/);
  assert.ok(
    html.indexOf('id="entry-photo-button"') <
      html.indexOf('id="entry-manual-button"')
  );
  assert.match(
    html,
    /class="entry-choice-option is-primary"[\s\S]*id="entry-photo-button"/
  );

  assert.match(app, /function openEntryChoice\(/);
  assert.match(
    app,
    /#top-add-button"\)\.addEventListener\("click", \(event\) =>[\s\S]*openEntryChoice/
  );
  assert.match(
    app,
    /#quick-add-button"\)\.addEventListener\("click", \(event\) =>[\s\S]*openEntryChoice/
  );
  assert.match(app, /const openAdd = event\.target\.closest\("\[data-open-add\]"\)[\s\S]*openEntryChoice\(openAdd\)/);
  assert.doesNotMatch(
    app,
    /#top-add-button"\)\.addEventListener\("click", openAddDialog\)/
  );
  assert.doesNotMatch(
    app,
    /#quick-add-button"\)\.addEventListener\("click", openAddDialog\)/
  );

  assert.match(
    app,
    /function openPhotoEntry\(\) \{\s*state\.entryPhotoPickerActive = true;\s*\$\("#entry-photo-file-input"\)\.click\(\);/
  );
  assert.doesNotMatch(
    app,
    /function openPhotoEntry\(\)[\s\S]{0,180}navigateTo\("scan"\)/
  );
  assert.match(
    app,
    /function openManualEntry\(\)[\s\S]*openAddDialog\(\)/
  );
  assert.match(
    app,
    /function returnToEntryChoiceFromManual\(\)[\s\S]*openEntryChoice\(null, \{ preserveTrigger: true \}\)/
  );
  assert.match(app, /#entry-photo-button"\)\.addEventListener\("click", openPhotoEntry\)/);
  assert.match(app, /#entry-manual-button"\)\.addEventListener\("click", openManualEntry\)/);
  assert.match(app, /#manual-entry-back-button"\)\.addEventListener/);
  assert.match(
    app,
    /const files = \[\.\.\.\(event\.target\.files \|\| \[\]\)\];[\s\S]*if \(!files\.length\) return;[\s\S]*closeEntryChoice\(\{ restoreFocus: false, preserveTrigger: true \}\);[\s\S]*uploadScanFiles\(files, \{ returnToEntryChoice: true \}\)/
  );
  assert.match(app, /state\.entryPhotoPickerActive = true/);
  assert.match(
    app,
    /#entry-photo-file-input"\)\.addEventListener\("cancel"[\s\S]*entryPhotoCancelGuard = true/
  );
  assert.match(
    app,
    /#entry-choice-dialog"\)\.addEventListener\("cancel"[\s\S]*entryPhotoPickerActive[\s\S]*entryPhotoCancelGuard[\s\S]*return;/
  );
  assert.match(app, /openCropEditor\(lastUploaded\.id, "scan", \{\s*returnToEntryChoice: true/);
  assert.match(
    app,
    /function cancelCropEditor\(\)[\s\S]*openEntryChoice\(null, \{ preserveTrigger: true \}\)/
  );
  assert.match(app, /revealWhenReady: editor\.returnToEntryChoice === true/);
  assert.match(app, /showView\("scan", \{ updateHash: false \}\)/);
  assert.match(app, /#entry-choice-dialog"\)\.addEventListener\("cancel"/);
  assert.match(app, /entry-photo-button"\)\.focus/);
  assert.match(html, /id="entry-photo-file-input"/);
  assert.doesNotMatch(html, /entry-photo-step/);
  assert.doesNotMatch(html, /id="entry-photo-pick-button"/);
  assert.doesNotMatch(app, /renderEntryChoiceStep/);

  assert.match(styles, /\.entry-choice-option\.is-primary/);
  assert.match(styles, /\.entry-choice-option:focus-visible/);
  assert.match(styles, /\.entry-choice-dialog::backdrop/);
  assert.match(styles, /\.manual-entry-back-button/);
  assert.doesNotMatch(styles, /\.entry-photo-step/);
  assert.doesNotMatch(styles, /\.entry-photo-actions/);
  assert.match(styles, /min-height:\s*82px/);
});
