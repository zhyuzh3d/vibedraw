import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "hermit.json"), "utf8"));
assert.equal(manifest.schema, 2);
assert.equal(manifest.happId, "com.zhyuzh.vibedraw");
assert.ok(Number.isInteger(manifest.version.code) && manifest.version.code > 0);

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const editorCss = fs.readFileSync(path.join(root, "styles/editor.css"), "utf8");
const componentsCss = fs.readFileSync(path.join(root, "styles/components.css"), "utf8");
const editorJs = fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8");
const canvasJs = fs.readFileSync(path.join(root, "app/components/canvas.js"), "utf8");
const settingsJs = fs.readFileSync(path.join(root, "app/components/settings.js"), "utf8");
const imageEngineJs = fs.readFileSync(path.join(root, "app/services/image-engine.js"), "utf8");
const providersJs = fs.readFileSync(path.join(root, "app/services/providers.js"), "utf8");
const renderPreviewJs = fs.readFileSync(path.join(root, "app/components/render-preview.js"), "utf8");
assert.ok(html.includes('id="result-opacity"') && html.includes('id="result-visibility"'), "canvas bar must expose result opacity and visibility");
assert.ok(!html.includes('id="generation-strength"') && html.includes('id="seed-lock"'), "generation bar must remove the sketch-strength slider and retain seed rolling");
assert.ok(html.includes('id="overlay-toggle"') && html.includes('id="snapshot-canvas"'), "generation bar must expose overlay and snapshot controls");
assert.equal((html.match(/data-adjust="result/g) || []).length, 6, "canvas must expose six inline color adjustment sliders");
assert.ok(html.includes('id="color-adjust-panel"'), "color adjustments must live below the canvas");
assert.ok(html.includes('id="color-adjust-reset"') && html.includes('id="color-adjust-default"'), "color panel must expose reset and default actions");
assert.ok(html.includes('id="color-adjust-close"') && html.includes('id="color-adjust-enabled"'), "color panel must expose close and effect toggle actions");
assert.ok(html.includes('id="seed-value"') && !html.match(/id="seed-lock"[^>]*aria-pressed/), "dice must show the seed and must not be a lock switch");
assert.ok(html.indexOf('id="generate-quick"') < html.indexOf('id="seed-lock"') && html.indexOf('id="seed-lock"') < html.indexOf('id="generate-quality"'), "seed button must sit between Fast and Quality");
assert.ok(/id="generate-quality"[\s\S]*data-zh="渲染"/.test(html), "quality action must be presented as Render");
assert.ok(html.includes('id="render-preview"') && html.includes('id="render-preview-download"') && html.includes('id="render-preview-stage"'), "Render must have a fullscreen preview with download controls");
assert.ok(renderPreviewJs.includes('scale = Math.max(1, Math.min(8') && renderPreviewJs.includes('type: "pan"') && renderPreviewJs.includes('type: "pinch"'), "render preview must support bounded pan and pinch zoom");
assert.ok(imageEngineJs.includes('config.width = 1024; config.height = 1024; config.inputMode = "sketch"') && imageEngineJs.includes('canvasInput.composeVisibleInput(referenceOptions)') && imageEngineJs.includes('dimensions.width !== 1024'), "Render must submit the visible canvas and require a real 1024 square result");
assert.ok(providersJs.includes('resolution_tier: dream ? "compact512" : "standard1024"'), "A1X quality render must request its 1024 output tier");
assert.ok(canvasJs.includes('async function exportVisibleCanvas()') && editorJs.includes('canvas.exportVisibleCanvas()') && !editorJs.includes('function exportOptions()'), "toolbar Download must directly export the visible canvas");
assert.match(editorJs, /seed-lock[\s\S]*generate-quick["']\)\.click\(\)/, "rolling a seed must trigger Fast generation");
assert.match(editorCss, /\.auto-button,\.generation-button\{[^}]*width:44px;height:44px;flex:0 0 44px/);
assert.match(editorCss, /\.seed-random-button,\.overlay-generate-button,\.snapshot-button,\.export-button\{[^}]*width:44px;height:44px;flex:0 0 44px/);
assert.ok(html.includes('id="prompt-display"') && !html.includes('id="prompt-input"') && !html.includes('id="prompt-save"'), "top prompt must be a read-only scrolling summary");
assert.match(editorCss, /\.prompt-panel\{[^}]*border:0;[^}]*background:transparent/);
assert.match(editorCss, /\.work-name span\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
assert.ok(!editorJs.includes("app.state.prompt.slice") && !fs.readFileSync(path.join(root, "app/services/store.js"), "utf8").includes("snapshot.prompt.slice"), "prompt text must never become an artwork title");
assert.ok(!editorJs.includes('node("generation-strength")') && editorJs.includes('node("overlay-toggle")'), "editor must bind overlay instead of the removed strength slider");
assert.ok(settingsJs.includes('class="toggle-switch" name="overlayGenerate" type="checkbox" role="switch"'), "artwork overlay setting must use the common switch control");
assert.ok(canvasJs.includes("async function snapshotVisible()") && canvasJs.includes("renderComposition(composition, WIDTH, true)") && canvasJs.includes("width: WIDTH, height: WIDTH"), "snapshot must flatten the current visible layer order into a full-canvas image element");
assert.ok(canvasJs.includes("composition.layerOpacity") && canvasJs.includes("if (composition.overlayGenerate)") && canvasJs.includes("if (visibleSnapshot) await drawCompositionResult"), "composition must place the result below translucent elements only in overlay mode");
assert.ok(canvasJs.includes('marqueeOnDrag: Boolean(hit && hit.type === "image" && !hitAlreadySelected)') && canvasJs.includes('!selectionGesture.marqueeOnDrag'), "dragging from an unselected image must start a marquee instead of moving the image");
assert.ok(editorJs.includes('image.style.zIndex = overlay ? "1" : "4"') && editorJs.includes('state.resultOpacity = app.state.overlayGenerate ? 1 : 0.9'), "display mode must swap result layering and reset its opacity");
assert.ok(editorJs.includes('app.state.layerOpacity = value') && editorJs.includes('app.state.resultOpacity = value'), "top opacity slider must target the active layer");
assert.match(editorJs, /snapshot-canvas[\s\S]*canvas\.snapshotVisible\(\)/);
assert.ok(html.includes('id="vibedraw-sharpen-matrix"'), "clarity must use a real sharpening convolution filter");
assert.ok(html.includes('id="canvas-fullscreen"') && html.includes('id="fullscreen-bottom"'), "fullscreen canvas controls must have fixed top and bottom anchors");
assert.ok(html.includes('id="fullscreen-tools-toggle"'), "fullscreen bottom tools must expose a collapse handle");
assert.ok(html.includes('id="modal-actions"'), "modal shell must provide an action area outside scrolling content");
assert.match(editorCss, /body\.canvas-fullscreen \.canvas-bar\{position:fixed;/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-bottom\{position:fixed;/);
assert.ok(editorCss.includes('body.canvas-fullscreen.canvas-interacting .canvas-bar,body.canvas-fullscreen.canvas-interacting .canvas-action-help{opacity:0;'));
assert.match(editorCss, /body\.canvas-fullscreen\.canvas-interacting \.fullscreen-bottom\{opacity:0;/);
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.fullscreen-bottom\{[^}]*background:none;[^}]*pointer-events:none/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-tools-toggle\{[^}]*top:36px;[^}]*width:48px;height:38px;[^}]*border-radius:9px 9px 0 0;[^}]*backdrop-filter:blur\(16px\)/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-bottom>\.drawing-dock\{[^}]*background:rgba[^}]*backdrop-filter:blur\(18px\)[^}]*contrast\(1\.24\)/, "fullscreen tools must use a translucent frosted-glass surface");
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.fullscreen-bottom>\.drawing-dock[^}]*display:none/);
assert.match(editorCss, /body\.canvas-fullscreen #canvas-fullscreen\{background:var\(--accent\);color:#fff/);
assert.ok(canvasJs.includes('app.events.emit("canvas:interaction"') && editorJs.includes('app.events.on("canvas:interaction"'), "fullscreen chrome must follow canvas interaction lifecycle");
assert.match(componentsCss, /\.modal-actions\{[^}]*flex:0 0 auto/);
assert.match(componentsCss, /\.work-settings-sheet\{height:88vh\}/);
assert.ok(settingsJs.includes('sheetClass: "work-settings-sheet"') && settingsJs.includes('footerHtml: footer(') && !settingsJs.includes('mode: "center", contentClass: "work-settings-content"'), "artwork settings must use a bottom sheet with external fixed actions");
assert.ok(!settingsJs.includes('range("colorStrength"') && settingsJs.includes('绘制稿保留强度'), "the temporary A1X single-path experiment must expose one preservation control without a separate color control");
assert.ok(canvasJs.includes('"colorStrength"'), "color strength must be restored with artwork canvas state");
assert.ok(html.includes('id="stroke-opacity"'), "drawing tools must expose direct stroke opacity");
assert.ok(html.includes('id="background-color"') && html.includes('<span aria-hidden="true">BG</span>') && editorCss.includes('.bg-control span{'), "background color control must show a centered BG label");
assert.ok(html.includes('id="canvas-action-help"') && html.includes('id="tool-action-help"') && (html.match(/data-help-zh=/g) || []).length >= 20 && editorJs.includes('function bindActionHelp()'), "canvas, drawing, and generation actions must explain their effect after a click");
assert.ok(settingsJs.includes('range("colorOpacity"') && settingsJs.includes('object.opacity = opacity') && settingsJs.includes('app.state.opacity = opacity'), "color dialogs must apply opacity to the active stroke tool or selected strokes");
assert.match(componentsCss, /\.color-slider-stack \.field\{margin-bottom:5px\}/, "color sliders must use the compact vertical stack");
assert.ok(!html.includes('id="brush-more"'), "stroke opacity must not be hidden behind a modal button");
assert.ok(html.includes('id="selection-canvas"'), "selection chrome must have its own overlay");
assert.match(editorCss, /\.draft-canvas\{z-index:2;/);
assert.match(editorCss, /\.selection-canvas\{z-index:3;[^}]*pointer-events:none/);
assert.match(editorCss, /\.result-image\{z-index:4;[^}]*pointer-events:none;touch-action:none/);
assert.ok(!html.includes('id="stage-badge"'), "canvas must not show a preview badge");
const references = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1]);
for (const reference of references) {
  if (reference.startsWith("/__hermit/") || reference.startsWith("data:")) continue;
  assert.ok(!/^https?:/i.test(reference), `runtime remote dependency: ${reference}`);
  assert.ok(fs.existsSync(path.join(root, reference.replace(/^\.\//, ""))), `missing reference: ${reference}`);
}

const scriptOrder = references.filter(value => value.endsWith(".js"));
assert.equal(scriptOrder[0], "./app/core/namespace.js");
assert.equal(scriptOrder.at(-1), "./app/app.js");

const sourceFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|html|css)$/.test(entry.name)) sourceFiles.push(full);
  }
}
walk(path.join(root, "app"));
walk(path.join(root, "styles"));
sourceFiles.push(path.join(root, "index.html"));

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  assert.ok(!/\b(?:import|export)\s+(?:\{|default|from)/.test(source), `ES module syntax in ${file}`);
  assert.ok(!/\?\.|\?\?|&&=|\|\|=/.test(source), `unsupported modern syntax in ${file}`);
  assert.ok(!/https?:\/\/(?:cdn|unpkg|jsdelivr)/i.test(source), `CDN dependency in ${file}`);
  if (file.endsWith(".js")) childProcess.execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

childProcess.execFileSync(process.execPath, [path.join(root, "tests/providers.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/workspace.test.mjs")], { stdio: "inherit" });
if (!process.argv.includes("--source-only") && fs.existsSync(path.join(root, "hermit-install.json"))) {
  childProcess.execFileSync("python3", [path.join(root, "tools/package.py"), "--check"], { stdio: "inherit" });
}
console.log(`verify.mjs: ok (${sourceFiles.length} runtime files)`);
